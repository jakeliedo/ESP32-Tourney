// =============================================================
// sas_polling.cpp – SAS FreeRTOS Task
//
// Key design points from research:
//  - 9-bit UART emulation on TX: ESP-IDF has no UART_PARITY_MARK/SPACE
//    (confirmed absent from hal/uart_types.h – only DISABLE/EVEN/ODD
//    exist). Instead we pick EVEN or ODD per byte based on that byte's
//    own popcount, so the resulting parity bit lands on the desired
//    9th-bit value (see uart_set_parity_for_bit9()).
//  - RX needs no such trick: per SAS 6.02 spec Section 1.2.1, the EGM
//    is never bus master and clears the wakeup bit on every byte it
//    sends back, so all response bytes carry bit9=0 by protocol
//    definition (the lone exception, Section 4.2 loop-break "chirp",
//    only fires once the host has stopped polling for 5s already).
//  - 40ms strict polling cycle via vTaskDelayUntil
//  - CRC-16 validated on every Long Poll response
//  - State machine tracks INIT/IDLE/PLAYING/TOURNAMENT_LOCKED/HANDPAY/OFFLINE
//  - Retries up to SAS_MAX_RETRIES before declaring machine offline
//  - Every raw byte sent/received on the SAS UART is hex-dumped to the
//    USB debug console (UART0, `pio device monitor`) via sas_send_frame()/
//    sas_receive() below, gated by SAS_LOG_RAW_FRAMES so it can be turned
//    off later with a single build_flags define without touching this file.
//
// NOTE: ESP32-C3 is single-core – this task shares Core 0 with the
// MQTT Network Task. Isolation comes from FreeRTOS priority (this
// task runs at configMAX_PRIORITIES-1, highest), not core pinning.
// UART reads block/yield (uart_read_bytes with a tick timeout) rather
// than busy-spin, so the lower-priority MQTT task still gets CPU time
// during each poll cycle's wait windows.
// =============================================================
#include "sas_polling.h"
#include "sas_commands.h"
#include "crc16.h"
#include "../../include/config.h"
#include "../machine_config.h"
#include "../led_indicator.h"

#include <Arduino.h>
#include <driver/uart.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <nvs_flash.h>
#include <nvs.h>
#include <string.h>

static const char* TAG = "SAS_POLL";

// Raw TX/RX hex dump of every byte on the SAS UART, printed to the
// USB debug console. Default ON for hardware bring-up with a real
// machine; override with -DSAS_LOG_RAW_FRAMES=0 in platformio.ini
// once the link is confirmed working, since a line per poll cycle
// (every 40ms) is a lot of console traffic to leave on forever.
#ifndef SAS_LOG_RAW_FRAMES
#define SAS_LOG_RAW_FRAMES 1
#endif

#if SAS_LOG_RAW_FRAMES
static void hex_dump(const char* label, const uint8_t* data, size_t len) {
    if (len == 0) {
        ESP_LOGI(TAG, "%s: (no data)", label);
        return;
    }
    char buf[3 * 64 + 1];
    size_t pos = 0;
    for (size_t i = 0; i < len && i < 64 && pos + 3 < sizeof(buf); i++) {
        pos += snprintf(buf + pos, sizeof(buf) - pos, "%02X ", data[i]);
    }
    ESP_LOGI(TAG, "%s (%u bytes): %s", label, (unsigned)len, buf);
}
#endif

// Verified against IGT SAS Protocol Version 6.02 (Nov 15 2005), Appendix A,
// General Poll Exception Codes -- the earlier version of this table had
// every entry wrong except 0x11/0x12 (guessed values, never checked
// against the real spec). Add entries here as new codes are observed
// on real hardware and confirmed against Appendix A.
static const char* exc_name(uint8_t exc) {
    switch (exc) {
        case 0x11: return "Slot door OPENED";
        case 0x12: return "Slot door CLOSED";
        case 0x17: return "AC power applied";
        case 0x18: return "AC power lost";
        case 0x1F: return "No activity, waiting for player input (obsolete)";
        case 0x20: return "General tilt";
        case 0x27: return "Cashbox full detected";
        case 0x2E: return "Cashbox near full detected";
        case 0x3C: return "Operator changed options";
        case 0x3D: return "Cash out ticket has been printed";
        case 0x3E: return "Handpay has been validated";
        case 0x3F: return "Validation ID not configured";
        case 0x44: return "Reel 4 tilt";
        case 0x51: return "Handpay pending";
        case 0x52: return "Handpay was reset";
        case 0x57: return "System validation request";
        case 0x66: return "Cash out button pressed";
        case 0x67: return "Ticket has been inserted";
        case 0x68: return "Ticket transfer complete";
        case 0x69: return "AFT transfer complete";
        case 0x6A: return "AFT request for host cashout";
        case 0x6B: return "AFT request for host to cash out win";
        case 0x6F: return "Game locked";
        case 0x7C: return "Legacy bonus pay awarded";
        default:   return "Unknown";
    }
}

// Shared inter-task queues (defined here, declared extern in header)
QueueHandle_t g_command_queue = NULL;
QueueHandle_t g_report_queue  = NULL;

static volatile SlotState s_state = SLOT_STATE_INIT;
static int     s_retry_count      = 0;

// AFT registration state (LP 0x73) -- obtained once from the machine and
// then reused on every LP 0x72 transfer. Added 2026-09-05: transfers kept
// failing with AFT_STATUS_BAD_ASSET even with the machine's own confirmed
// real asset number, because the Registration Key it expects back is
// issued by the machine itself via LP 0x73, not something we can guess.
static bool     s_aft_registered      = false;
static uint32_t s_aft_asset_number    = 0;
static uint8_t  s_aft_registration_key[20] = {0};

// Host-chosen AFT registration key (SAS 6.02 Section 8.1: "the desired
// registration key... The final registration key must be non-zero").
// This is picked by the host, not issued by the machine -- any fixed
// non-zero 20-byte pattern is valid; the machine just echoes it back on
// every subsequent LP 0x72 for us to match. Not a secret/credential.
static const uint8_t s_aft_registration_key_init[20] = {
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A,
    0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14
};

// Physical machine identity (LP 0x54), queried once near boot -- see
// query_machine_identity() and sas_polling.h for why this exists
// separately from g_machine_id (which is just our own NVS-assigned
// leaderboard/MQTT identity, not proof of which real cabinet is wired
// to this board).
static bool s_identity_known         = false;
static char s_serial_number[41]      = {0};
static char s_sas_version[4]         = {0};

// See query_machine_denom() and sas_polling.h for why this exists --
// raw SAS credit/meter/handpay values are all expressed in units of this
// denomination (Section 16, Table C-4), not always cents.
static bool     s_denom_known           = false;
static uint8_t  s_denom_code            = 0;
static uint32_t s_denom_value_x10000    = 0;

// ── Internal UART helpers ──────────────────────────────────────

/**
 * Force the parity bit (SAS 9th/wakeup bit) to a specific value for
 * this byte, using only EVEN/ODD (MARK/SPACE don't exist in ESP-IDF).
 * EVEN parity sets the bit so total 1-count (data+parity) is even,
 * i.e. parity_bit = popcount(byte) % 2. ODD gives the complement.
 * Picking whichever of EVEN/ODD yields the wanted bit, per byte,
 * reproduces MARK (bit9=1) for address bytes and SPACE (bit9=0) for
 * data bytes regardless of the byte's own value.
 */
static void uart_set_parity_for_bit9(uint8_t byte, bool bit9_high) {
    bool even_gives_1 = (__builtin_popcount(byte) % 2) == 1;
    bool want_even = bit9_high ? even_gives_1 : !even_gives_1;
    uart_set_parity(SAS_UART_NUM, want_even ? UART_PARITY_EVEN : UART_PARITY_ODD);
}

/**
 * Transmit a single byte with the correct 9th-bit value.
 * Address bytes get bit9=1, all subsequent data bytes get bit9=0.
 * Must wait for the byte (incl. its parity bit) to fully shift out
 * before returning, since the next call may change the parity
 * register for the following byte – changing it mid-shift would
 * corrupt the bit actually placed on the wire.
 */
static void sas_send_byte(uint8_t byte, bool is_address) {
    uart_set_parity_for_bit9(byte, is_address);
    uart_write_bytes(SAS_UART_NUM, (const char*)&byte, 1);
    uart_wait_tx_done(SAS_UART_NUM, pdMS_TO_TICKS(10));
    led_pulse_serial();  // every real byte sent on the SAS link -- see led_indicator.h
}

/**
 * Transmit a Long Poll frame per SAS 6.02 Section 2.2.2.1 (Type R):
 * "the gaming machine address, with the wakeup bit set, followed by
 * a single-byte command code" -- i.e. exactly ONE address byte (MARK,
 * bit9=1), then cmd/data/CRC (SPACE, bit9=0). No extra preamble byte.
 * A prior version of this firmware prepended a second MARK byte
 * (SAS_POLL_ADDRESS) before the real address, which is not part of
 * the spec and is structurally the same "two consecutive MARK bytes"
 * pattern documented (CLAUDE.md, 2026-09 SAS debug log) to make real
 * machines echo the poll back instead of responding to it.
 * Always runs at 1 stop bit (restored here in case the General Poll
 * path above left the UART at 2 stop bits).
 */
static void sas_send_frame(const uint8_t* frame, size_t len) {
    uart_set_stop_bits(SAS_UART_NUM, UART_STOP_BITS_1);
    uart_flush(SAS_UART_NUM);
#if SAS_LOG_RAW_FRAMES
    hex_dump("SAS TX", frame, len);
#endif
    sas_send_byte(frame[0], true);          // machine address – MARK (wakeup bit)
    for (size_t i = 1; i < len; i++) {
        sas_send_byte(frame[i], false);     // cmd/data/CRC – SPACE
    }
}

/**
 * General Poll ("events poll") per SAS 6.02 Section 2.2.1: "the host
 * transmits a single-byte message consisting of the gaming machine's
 * address ORed with 80 hex with the wakeup bit set." That's exactly
 * ONE byte, address|0x80, with a genuine bit9=1 (MARK) -- not two
 * bytes, and not a byte sent with parity disabled (which transmits no
 * wakeup bit at all, so the machine has no way to recognize it as an
 * address byte per Section 1.2.1 and never responds). Returns 1 if an
 * exception byte was read into *out_exc, 0 on timeout (no exception
 * queued -- the normal case).
 */
/**
 * Send a global-broadcast address byte (0x00 | 0x80, wakeup bit set),
 * expecting no reply. Per SAS 6.02 Section 3.3 (Synchronization), after
 * a warm/cold start or any loop-break (Section 4.2) a gaming machine
 * ignores every poll addressed to itself until it sees a poll to a
 * DIFFERENT machine address, or a poll to address zero -- only then
 * does it reset its poll-state counter and start responding. With a
 * single machine on this bus we never poll any other address, so
 * without this one-time broadcast the machine would silently ignore
 * every poll forever, indistinguishable from a dead link.
 */
static void sas_send_sync_broadcast() {
    uart_set_stop_bits(SAS_UART_NUM, UART_STOP_BITS_1);
    uart_flush(SAS_UART_NUM);
    uint8_t byte = 0x80; // address 0x00 | 0x80, wakeup bit set
#if SAS_LOG_RAW_FRAMES
    hex_dump("SAS TX(sync)", &byte, 1);
#endif
    sas_send_byte(byte, true);
}

static size_t sas_general_poll(uint8_t machine_address, uint8_t* out_exc) {
    uart_set_stop_bits(SAS_UART_NUM, UART_STOP_BITS_1);
    uart_flush(SAS_UART_NUM);

    uint8_t byte = (uint8_t)(0x80 | machine_address);
#if SAS_LOG_RAW_FRAMES
    hex_dump("SAS TX(gp)", &byte, 1);
#endif
    sas_send_byte(byte, true);   // single address byte, wakeup bit set

    // Real SAS response bytes always carry bit9=0 (see sas_receive's header
    // comment) followed by one genuine stop bit -- an 11-bit frame, same as
    // every other SAS response on this link. 2 stop bits (matching pyserial's
    // PARITY_NONE/STOPBITS_TWO trick 1:1) makes ESP32's UART hardware demand
    // BOTH trailing bit-times be logic-1, but the real bit9=0 violates that
    // and reads as a framing error on real hardware -- unlike a PC UART/driver,
    // which tends to tolerate it. Switch to a fixed parity (value doesn't
    // matter, we don't check the parity-error flag) + 1 stop bit before
    // reading, matching the framing every other RX on this link already uses.
    uart_set_parity(SAS_UART_NUM, UART_PARITY_EVEN);
    uart_set_stop_bits(SAS_UART_NUM, UART_STOP_BITS_1);

    size_t received = 0;
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(SAS_RESPONSE_TIMEOUT);
    while (received < 1 && xTaskGetTickCount() < deadline) {
        int n = uart_read_bytes(SAS_UART_NUM, out_exc + received, 1 - received, pdMS_TO_TICKS(2));
        if (n > 0) { received += n; led_pulse_serial(); }
    }
#if SAS_LOG_RAW_FRAMES
    if (received > 0) {
        hex_dump("SAS RX(gp)", out_exc, received);
    } else {
        ESP_LOGI(TAG, "SAS RX(gp): no response (timeout %dms)", SAS_RESPONSE_TIMEOUT);
    }
#endif
    return received;
}

/**
 * Wait for a response from the machine with timeout.
 * Returns number of bytes read, or 0 on timeout.
 */
static size_t sas_receive(uint8_t* buf, size_t max_len,
                           uint16_t timeout_ms = SAS_RESPONSE_TIMEOUT) {
    size_t received = 0;
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(timeout_ms);

    while (received < max_len && xTaskGetTickCount() < deadline) {
        int n = uart_read_bytes(SAS_UART_NUM, buf + received,
                                max_len - received, pdMS_TO_TICKS(2));
        if (n > 0) { received += n; led_pulse_serial(); }
    }
#if SAS_LOG_RAW_FRAMES
    if (received > 0) {
        hex_dump("SAS RX", buf, received);
    } else {
        ESP_LOGI(TAG, "SAS RX: no response (timeout %dms)", timeout_ms);
    }
#endif
    return received;
}

// ── NVS transaction persistence ───────────────────────────────

static void nvs_save_pending_txn(const char* txn_id, uint32_t amount) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, NVS_KEY_TXN_ID, txn_id);
        nvs_set_u32(h, NVS_KEY_TXN_AMT, amount);
        nvs_commit(h);
        nvs_close(h);
    }
}

static void nvs_clear_pending_txn() {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, NVS_KEY_TXN_ID);
        nvs_erase_key(h, NVS_KEY_TXN_AMT);
        nvs_commit(h);
        nvs_close(h);
    }
}

static bool nvs_load_pending_txn(char* txn_id_out, uint32_t* amount_out) {
    nvs_handle_t h;
    bool found = false;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = 21;
        if (nvs_get_str(h, NVS_KEY_TXN_ID, txn_id_out, &len) == ESP_OK &&
            nvs_get_u32(h, NVS_KEY_TXN_AMT, amount_out) == ESP_OK) {
            found = true;
        }
        nvs_close(h);
    }
    return found;
}

// ── Report queue helper ────────────────────────────────────────

static void report_event(uint8_t exc, uint32_t credits,
                         uint32_t coin_in, uint32_t coin_out,
                         uint8_t aft_status, const char* txn_id) {
    MachineEvent ev;
    ev.exception_code = exc;
    ev.credits        = credits;
    ev.coin_in        = coin_in;
    ev.coin_out       = coin_out;
    ev.state          = s_state;
    ev.aft_status     = aft_status;
    if (txn_id) strncpy(ev.txn_id, txn_id, 20);
    else        ev.txn_id[0] = '\0';

    xQueueSend(g_report_queue, &ev, 0);  // non-blocking; drop if full
}

// ── Type-S simple command (Shutdown/Startup/Enable|Disable Bill) ──

static bool execute_simple_command(uint8_t sas_cmd) {
    uint8_t frame[4];
    uint8_t resp[1];
    size_t frame_len = sas_build_lp_simple(frame, g_machine_id, sas_cmd);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, 1);
    bool acked = (n == 1 && resp[0] == g_machine_id);
    if (!acked) ESP_LOGW(TAG, "LP 0x%02X: no ACK (n=%d)", sas_cmd, (int)n);
    return acked;
}

// ── AFT registration (LP 0x73) ──────────────────────────────────

/**
 * Register this host for AFT transfers, per SAS 6.02 Section 8.1. Must
 * succeed before any LP 0x72 transfer will be accepted -- a transfer
 * sent with an all-zero Registration Key gets rejected with
 * AFT_STATUS_BAD_ASSET (0x93) regardless of the asset number (confirmed
 * on real hardware 2026-09-05).
 *
 * This is a two-poll handshake (see AFT_REG_CODE_* in sas_commands.h
 * for the full spec citation -- a prior version of this firmware only
 * sent step 1 and treated "ready" as good enough, which is why every
 * subsequent LP 0x72 carried an all-zero key and got rejected):
 *   0. AFT_REG_CODE_QUERY (0xFF) -- read-only, asks the machine for its
 *      own currently-configured Asset Number instead of guessing one in
 *      config.h (SAS_AFT_ASSET_NUMBER is only a fallback if this comes
 *      back zero/unreadable -- the machine ignores any asset number we
 *      send in Query mode, so there was never a way to "discover" it by
 *      trial and error on the later steps; asking directly is the actual
 *      spec-documented way, Section 8.1: "the host may interrogate the
 *      current registration status by setting the registration code to
 *      FF").
 *   1. AFT_REG_CODE_INIT (0x00), zeroed key, the asset number from step 0
 *      -- moves the machine to registration status "ready" (0x00).
 *   2. AFT_REG_CODE_COMPLETE (0x01), the SAME asset number, and a
 *      host-chosen NON-ZERO key -- only this step actually completes
 *      registration (status "registered", 0x01).
 * Cached in s_aft_registered so this only runs once per boot.
 */
static bool perform_aft_registration() {
    uint8_t frame[36];
    uint8_t resp[40];
    uint8_t zero_key[20] = {0};

    // Step 0: Query the machine's real, currently-configured asset number.
    uint32_t asset_number = SAS_AFT_ASSET_NUMBER;
    size_t frame_len = sas_build_lp_aft_register(frame, g_machine_id, AFT_REG_CODE_QUERY, 0, zero_key, 0);
    sas_send_frame(frame, frame_len);
    size_t qn = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);
    if (qn > 0) {
        SasAftRegisterResponse q = sas_parse_aft_register(resp, qn);
        if (q.valid && q.asset_number != 0) {
            asset_number = q.asset_number;
            ESP_LOGI(TAG, "AFT registration: machine reports asset number %lu (config.h has %lu)",
                     (unsigned long)asset_number, (unsigned long)SAS_AFT_ASSET_NUMBER);
        } else {
            ESP_LOGW(TAG, "AFT registration: machine has no asset number configured (query returned 0) "
                           "-- an operator must set one in the audit menu; falling back to config.h value %lu",
                     (unsigned long)SAS_AFT_ASSET_NUMBER);
        }
    } else {
        ESP_LOGW(TAG, "AFT registration: asset number query got no response, falling back to config.h value %lu",
                 (unsigned long)SAS_AFT_ASSET_NUMBER);
    }

    // Step 1: Initialize
    frame_len = sas_build_lp_aft_register(frame, g_machine_id, AFT_REG_CODE_INIT,
                                           asset_number, zero_key, 0);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);
    if (n == 0) {
        ESP_LOGW(TAG, "AFT registration step 1 (init): no response from machine");
        return false;
    }
    SasAftRegisterResponse reg = sas_parse_aft_register(resp, n);
    if (!reg.valid) {
        ESP_LOGW(TAG, "AFT registration step 1 (init): response CRC/parse error (n=%d)", (int)n);
        return false;
    }
    if (reg.status_code != AFT_REG_STATUS_READY) {
        ESP_LOGW(TAG, "AFT registration step 1 (init): machine returned status 0x%02X (expected ready)",
                 reg.status_code);
        return false;
    }

    // Step 2: Complete, with a host-chosen non-zero key
    frame_len = sas_build_lp_aft_register(frame, g_machine_id, AFT_REG_CODE_COMPLETE,
                                           asset_number, s_aft_registration_key_init, 0);
    sas_send_frame(frame, frame_len);
    n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);
    if (n == 0) {
        ESP_LOGW(TAG, "AFT registration step 2 (complete): no response from machine");
        return false;
    }
    reg = sas_parse_aft_register(resp, n);
    if (!reg.valid) {
        ESP_LOGW(TAG, "AFT registration step 2 (complete): response CRC/parse error (n=%d)", (int)n);
        return false;
    }
    if (reg.status_code != AFT_REG_STATUS_REGISTERED) {
        ESP_LOGW(TAG, "AFT registration step 2 (complete): machine returned status 0x%02X (expected registered)",
                 reg.status_code);
        return false;
    }

    s_aft_asset_number = reg.asset_number;
    memcpy(s_aft_registration_key, s_aft_registration_key_init, 20);
    s_aft_registered = true;
    ESP_LOGI(TAG, "AFT registration OK: asset=%lu", (unsigned long)reg.asset_number);
    return true;
}

// ── AFT execution ──────────────────────────────────────────────

// How long we're willing to block the SAS task retrieving the final
// status of a transfer that came back "pending" (0x40). Per spec, the
// machine keeps reporting exception 0x69 every 15s until acknowledged,
// so giving up here just means we'll pick up the pending state again on
// exception 0x69 or the next AFT command's flush step below -- it does
// NOT lose the transaction (NVS still has it, and the machine still has
// its own record of it).
#define AFT_INTERROGATE_MAX_ATTEMPTS 15
#define AFT_INTERROGATE_INTERVAL_MS  300

/**
 * Send one AFT interrogation poll with transfer_code=0xFF (interrogate +
 * ACKNOWLEDGE). Per SAS 6.02 Section 8.3, this is the ONLY transfer code
 * that closes a pending (0x40) transfer cycle -- 0xFE ("peek") does not.
 * Safe to call even when there is no pending transfer: the machine just
 * reports the status of the most recent one (harmless, no side effect on
 * an already-closed cycle).
 * @return true if a valid response was parsed into *out
 */
static bool interrogate_aft_ack(SasAftResponse* out) {
    uint8_t frame[96];
    uint8_t resp[128];
    size_t frame_len = sas_build_lp_aft(frame, g_machine_id,
                                         AFT_CODE_INTERROGATE_ACK, AFT_XFER_TO_MACHINE,
                                         AFT_AMOUNT_CASHABLE, 0, "",
                                         s_aft_asset_number, s_aft_registration_key);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);
    if (n == 0) return false;
    *out = sas_parse_aft(resp, n);
    return out->valid;
}

static void execute_aft_command(const ServerCommand* cmd) {
    // AFT (LP 0x72) request/response frames are much larger than other
    // Long Polls -- full field layout (registration key, 3 amount fields,
    // asset number, etc.) needs ~78 bytes request / up to ~90 bytes
    // response (measured 67 bytes on real hardware with an empty txn_id;
    // a full 20-char txn_id plus trailing meter fields can exceed that).
    // The old 32-byte buffers silently truncated every real response.
    uint8_t frame[96];
    uint8_t resp[128];

    // Persist before sending (power-fail safety)
    nvs_save_pending_txn(cmd->txn_id, cmd->amount);

    if (!s_aft_registered && !perform_aft_registration()) {
        ESP_LOGW(TAG, "AFT: registration failed, aborting transfer  txn=%s", cmd->txn_id);
        return;
    }

    // Discovered 2026-09-08: after a real $1 buy-in got status 0x40
    // (pending), every subsequent AFT_WITHDRAW attempt was rejected with
    // status 0xC0 ("not compatible with current transfer in progress"),
    // repeated across 7 separate button presses over ~25 seconds -- long
    // enough that the machine had almost certainly already resolved that
    // transfer internally (to success), but it stays "open" from the
    // host's point of view until acknowledged with an interrogation poll
    // (transfer code FF). "If the host sends any long poll 72 during a
    // transfer cycle, other than an interrogation poll..., the gaming
    // machine will respond with a transfer status of C0" (spec text,
    // Section 8.3). So: always flush/acknowledge whatever the machine
    // considers its current transfer before starting a new one. This is
    // a no-op (harmless) if there's nothing pending.
    SasAftResponse flush_result;
    if (interrogate_aft_ack(&flush_result) && flush_result.status_code == AFT_STATUS_PENDING) {
        ESP_LOGW(TAG, "AFT: prior transfer still pending at start of new command, "
                      "waiting for it to close before proceeding  txn=%s", cmd->txn_id);
        for (int attempt = 0; attempt < AFT_INTERROGATE_MAX_ATTEMPTS; attempt++) {
            vTaskDelay(pdMS_TO_TICKS(AFT_INTERROGATE_INTERVAL_MS));
            if (interrogate_aft_ack(&flush_result) && flush_result.status_code != AFT_STATUS_PENDING) {
                ESP_LOGI(TAG, "AFT: prior transfer closed with status=0x%02X, proceeding",
                         flush_result.status_code);
                break;
            }
        }
    }

    // Transfer type selects the real SAS direction/purpose (Table 8.3d):
    // PUMP is host->machine (0x00); WITHDRAW must be machine->host (0x80),
    // not a "restricted" code -- a prior version of this firmware used
    // AFT_TYPE_RESTRICTED (0x10, "bonus coin-out TO the machine") for
    // withdraw, which doesn't take money out of the machine at all.
    uint8_t transfer_type = (cmd->cmd_type == CMD_AFT_PUMP)
                                ? AFT_XFER_TO_MACHINE
                                : AFT_XFER_FROM_MACHINE;
    uint8_t amount_category = AFT_AMOUNT_CASHABLE;
    uint8_t  transfer_code;
    uint32_t transfer_amount;

    if (cmd->cmd_type == CMD_AFT_WITHDRAW) {
        // Discovered 2026-09-08 on real hardware: the standard "request
        // all available credits" method (spec Section 8.4 -- set amount
        // to 9999999999, transfer code = partial allowed) got rejected
        // outright with status 0x86 ("gaming machine unable to perform
        // partial transfers to the host") on every attempt. This is a
        // real, spec-acknowledged machine limitation, not a framing bug:
        // "Due to jurisdictional or other considerations, some gaming
        // machines may refuse to perform partial transfers even if the
        // host specifies partial transfer allowed" (Section 8.3).
        //
        // Fix: query LP 0x74 (AFT Game Lock and Status) first -- Table
        // 8.2b's "current cashable amount" is the machine's own live
        // balance, reported ALREADY IN CENTS (unlike the LP 0x1A credit
        // meter, which is in accounting-denom units -- see
        // credits_to_cents()). Requesting a FULL transfer (code 0x00) for
        // that EXACT amount never needs partial-transfer support at all,
        // since a full transfer for the precise current balance isn't a
        // partial transfer by definition.
        uint8_t  lp74_frame[8];
        uint8_t  lp74_resp[48];
        size_t   lp74_len = sas_build_lp_aft_lock_status(lp74_frame, g_machine_id,
                                                           AFT_LOCK_CODE_INTERROGATE, 0, 0);
        sas_send_frame(lp74_frame, lp74_len);
        size_t lp74_n = sas_receive(lp74_resp, sizeof(lp74_resp), SAS_LONG_POLL_TIMEOUT);
        SasAftLockStatusResponse lock_status = (lp74_n > 0)
            ? sas_parse_aft_lock_status(lp74_resp, lp74_n)
            : SasAftLockStatusResponse{0, 0xFF, 0, 0, 0, 0, 0, 0, false};

        if (!lock_status.valid) {
            ESP_LOGW(TAG, "AFT OUT: LP 0x74 status query failed (n=%d), aborting withdraw  txn=%s",
                     (int)lp74_n, cmd->txn_id);
            return;
        }
        if (!(lock_status.available_transfers & 0x02)) {
            ESP_LOGW(TAG, "AFT OUT: machine reports \"transfer from gaming machine\" NOT currently "
                          "available (door open/tilt/disabled/cashout in progress?)  txn=%s", cmd->txn_id);
        }
        if (lock_status.current_cashable_amount == 0) {
            ESP_LOGI(TAG, "AFT OUT: machine reports 0 cashable cents, nothing to withdraw  txn=%s",
                     cmd->txn_id);
            nvs_clear_pending_txn();
            return;
        }
        ESP_LOGI(TAG, "AFT OUT: machine reports %lu cents cashable (partial-to-host %s), "
                      "requesting exact full transfer  txn=%s",
                 (unsigned long)lock_status.current_cashable_amount,
                 (lock_status.host_cashout_status & 0x02) ? "supported" : "NOT supported",
                 cmd->txn_id);

        transfer_code   = AFT_CODE_TRANSFER_FULL;
        transfer_amount = lock_status.current_cashable_amount;
    } else {
        transfer_code   = AFT_CODE_TRANSFER_FULL;
        transfer_amount = cmd->amount;
    }

    size_t frame_len = sas_build_lp_aft(frame, g_machine_id,
                                         transfer_code, transfer_type, amount_category,
                                         transfer_amount, cmd->txn_id,
                                         s_aft_asset_number, s_aft_registration_key);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);

    if (n > 0) {
        SasAftResponse aft = sas_parse_aft(resp, n);
        if (aft.valid) {
            uint8_t  final_status = aft.status_code;
            uint32_t final_amount = aft.transfer_amount;

            // Status 0x40 (PENDING) is NOT a failure -- it means the
            // transfer is still in progress. Discovered 2026-09-08: a
            // real $1 buy-in that returned 0x40 here physically succeeded
            // on the machine seconds later, but this code used to log it
            // as "AFT FAIL" and never checked again. Per Section 8.3, the
            // host must follow up with interrogation poll(s) (transfer
            // code FF) until the status transitions to a final code.
            if (final_status == AFT_STATUS_PENDING) {
                bool resolved = false;
                for (int attempt = 0; attempt < AFT_INTERROGATE_MAX_ATTEMPTS; attempt++) {
                    vTaskDelay(pdMS_TO_TICKS(AFT_INTERROGATE_INTERVAL_MS));
                    SasAftResponse iaft;
                    if (interrogate_aft_ack(&iaft) && iaft.status_code != AFT_STATUS_PENDING) {
                        final_status = iaft.status_code;
                        final_amount = iaft.transfer_amount;
                        resolved = true;
                        break;
                    }
                }
                if (!resolved) {
                    ESP_LOGW(TAG, "AFT: still pending after %d interrogation attempts (%.1fs), "
                                  "giving up for now -- machine will keep reissuing exception 0x69 "
                                  "until acknowledged  txn=%s",
                             AFT_INTERROGATE_MAX_ATTEMPTS,
                             AFT_INTERROGATE_MAX_ATTEMPTS * AFT_INTERROGATE_INTERVAL_MS / 1000.0f,
                             cmd->txn_id);
                }
            }

            if (final_status == AFT_STATUS_SUCCESS || final_status == AFT_STATUS_PARTIAL) {
                nvs_clear_pending_txn();
                ESP_LOGI(TAG, "AFT OK: transferred %lu credits  txn=%s",
                         (unsigned long)final_amount, cmd->txn_id);
            } else if (final_status != AFT_STATUS_PENDING) {
                ESP_LOGW(TAG, "AFT FAIL: status=0x%02X  txn=%s",
                         final_status, cmd->txn_id);
            }
            report_event(SAS_EXC_AFT_TRANSFER_DONE, 0, 0, 0,
                         final_status, cmd->txn_id);
        } else {
            ESP_LOGW(TAG, "AFT: response CRC/parse error  n=%d  txn=%s",
                     (int)n, cmd->txn_id);
        }
    } else {
        ESP_LOGW(TAG, "AFT: no response from machine (n=0)  txn=%s", cmd->txn_id);
    }
}

// ── Physical machine identity (LP 0x54) ─────────────────────────

/**
 * Query the real machine's SAS version + serial number once near boot.
 * See sas_polling.h for why this exists (g_machine_id alone can't catch
 * a board wired to the wrong physical cabinet). Safe to call repeatedly
 * (e.g. retried by the caller) -- only updates state on a valid response.
 */
static bool query_machine_identity() {
    uint8_t frame[4];
    uint8_t resp[48];

    size_t frame_len = sas_build_lp_version_serial(frame, g_machine_id);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);

    if (n == 0) {
        ESP_LOGW(TAG, "Machine identity: no response from machine");
        return false;
    }

    SasVersionSerialResponse id = sas_parse_version_serial(resp, n);
    if (!id.valid) {
        ESP_LOGW(TAG, "Machine identity: response CRC/parse error (n=%d)", (int)n);
        return false;
    }

    strncpy(s_serial_number, id.serial_number, sizeof(s_serial_number) - 1);
    strncpy(s_sas_version,   id.sas_version,   sizeof(s_sas_version) - 1);
    s_identity_known = true;
    ESP_LOGI(TAG, "Machine identity: SAS v%s, serial=\"%s\"", s_sas_version, s_serial_number);
    return true;
}

// ── Real accounting denomination (LP 0x1F) ──────────────────────

/**
 * Query the real machine's accounting denomination once near boot. Every
 * plain SAS credit value (LP 0x1A credits, LP 0x1B handpay amount, LP
 * 0xAF/0x6F meters) is expressed in units of this denomination, NOT
 * always cents -- see SasMachineInfoResponse doc comment in
 * sas_commands.h. Safe to call repeatedly; only updates state on a valid
 * response.
 */
static bool query_machine_denom() {
    uint8_t frame[4];
    uint8_t resp[32];

    size_t frame_len = sas_build_lp_machine_info(frame, g_machine_id);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);

    if (n == 0) {
        ESP_LOGW(TAG, "Machine denom: no response from machine");
        return false;
    }

    SasMachineInfoResponse info = sas_parse_machine_info(resp, n);
    if (!info.valid) {
        ESP_LOGW(TAG, "Machine denom: response CRC/parse error (n=%d)", (int)n);
        return false;
    }

    if (info.denom_value_x10000 == 0) {
        ESP_LOGW(TAG, "Machine denom: code 0x%02X is \"none\"/unknown/reserved -- "
                      "falling back to no conversion (raw credit units treated as cents)",
                 info.denom_code);
        return false;
    }

    s_denom_code         = info.denom_code;
    s_denom_value_x10000 = info.denom_value_x10000;
    s_denom_known        = true;
    ESP_LOGI(TAG, "Machine denom: code=0x%02X = $%lu.%04lu per credit",
             s_denom_code,
             (unsigned long)(s_denom_value_x10000 / 10000),
             (unsigned long)(s_denom_value_x10000 % 10000));
    return true;
}

/**
 * Convert a raw SAS credit-unit value (credit meter, handpay amount,
 * coin in/out meters -- anything the spec calls plain "credits") into
 * cents, using the real queried denomination. Falls back to treating the
 * raw value as already-cents (this project's old hardcoded assumption)
 * if the denom hasn't been successfully queried yet, so behavior on a
 * 1-cent machine (the only one tested so far) is unchanged.
 */
static uint32_t credits_to_cents(uint32_t raw_credits) {
    if (!s_denom_known) return raw_credits;
    // cents = raw_credits * (dollars_x10000) / 10000 * 100 = raw_credits * dollars_x10000 / 100
    return (uint32_t)(((uint64_t)raw_credits * s_denom_value_x10000) / 100);
}

// ── Ticket lockdown (LP 0x7B) ────────────────────────────────────

/**
 * Disallow ticket-based cashout/redemption on the machine, once near boot.
 * Requirement (2026-09-08): while this EVO bridge is the active host, AFT
 * is meant to be the ONLY way credits leave/enter the machine -- a printed
 * cashout ticket or a redeemed ticket-in would move money without going
 * through our AFT/tournament tracking at all. LP 0x7B (Extended Validation
 * Status, Section 15.2) is the real SAS mechanism for this:
 *   - bit 0 (printer as cashout device) covers BOTH cashable AND
 *     restricted ticket cashouts per the spec text -- disabling it alone
 *     already blocks all player-initiated ticket printing.
 *   - bit 3 (print restricted tickets) is set too, redundantly but
 *     harmlessly, for defense in depth (belt and suspenders).
 *   - bit 5 (ticket redemption) blocks the machine from ACCEPTING a
 *     ticket a player inserts, so this bridge stays the exclusive channel
 *     in both directions.
 * Bits not in control_mask (handpay receipt printing/validation) are left
 * untouched -- this is specifically about player ticket cashout, not
 * handpay paperwork.
 * NOTE: this is a persistent machine-side configuration write, not a
 * continuously-held lock -- it does NOT automatically revert if this board
 * loses power or disconnects. Re-enabling ticket cashout (e.g. to return
 * the machine to standalone operation) requires another LP 0x7B (or an
 * operator menu option, if the machine provides one) setting those bits
 * back to 1.
 */
static bool configure_ticket_lockdown() {
    uint8_t frame[13];
    uint8_t resp[24];

    const uint16_t control_mask = VALIDATION_BIT_PRINTER_CASHOUT
                                 | VALIDATION_BIT_PRINT_RESTRICTED
                                 | VALIDATION_BIT_TICKET_REDEMPTION;
    const uint16_t status_bits  = 0x0000;  // disallow all three controlled bits

    size_t frame_len = sas_build_lp_validation_status(frame, g_machine_id,
                                                       control_mask, status_bits, 0, 0);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);

    if (n == 0) {
        ESP_LOGW(TAG, "Ticket lockdown: no response from machine");
        return false;
    }

    SasValidationStatusResponse st = sas_parse_validation_status(resp, n);
    if (!st.valid) {
        ESP_LOGW(TAG, "Ticket lockdown: response CRC/parse error (n=%d)", (int)n);
        return false;
    }

    ESP_LOGI(TAG, "Ticket lockdown: applied (status_bits=0x%04X) -- "
                  "printer-cashout=%d  restricted-tickets=%d  ticket-redemption=%d",
             st.status_bits,
             (st.status_bits & VALIDATION_BIT_PRINTER_CASHOUT)   ? 1 : 0,
             (st.status_bits & VALIDATION_BIT_PRINT_RESTRICTED)  ? 1 : 0,
             (st.status_bits & VALIDATION_BIT_TICKET_REDEMPTION) ? 1 : 0);
    return true;
}

// ── Recovery on boot: check if a pending AFT exists in NVS ────

static void recover_pending_aft() {
    char     txn_id[21] = {0};
    uint32_t amount     = 0;
    if (!nvs_load_pending_txn(txn_id, &amount)) return;

    // Stale/empty entry from a previous test or incomplete write — discard.
    if (txn_id[0] == '\0' || amount == 0) {
        nvs_clear_pending_txn();
        ESP_LOGI(TAG, "Cleared stale NVS pending entry (empty txn_id or amount=0)");
        return;
    }

    ESP_LOGW(TAG, "Recovering pending AFT txn=%s amount=%lu", txn_id,
             (unsigned long)amount);

    if (!s_aft_registered && !perform_aft_registration()) {
        ESP_LOGW(TAG, "AFT recovery: registration failed, will retry on next AFT command");
        return;
    }

    // Interrogate + ACKNOWLEDGE (transfer code FF, not FE) to see if the
    // machine already received the funds. This MUST be FF, not a bare
    // "peek" -- otherwise a transfer that resolved to pending (0x40)
    // before reboot stays open from the machine's point of view forever,
    // and every future AFT (including this recovery's own retry below)
    // gets rejected with 0xC0 (see AFT_CODE_INTERROGATE_ACK doc comment
    // in sas_commands.h, and interrogate_aft_ack()/execute_aft_command()
    // above for the full story of how this was discovered 2026-09-08).
    SasAftResponse aft;
    bool got_response = interrogate_aft_ack(&aft);
    for (int attempt = 0; got_response && aft.status_code == AFT_STATUS_PENDING
                          && attempt < AFT_INTERROGATE_MAX_ATTEMPTS; attempt++) {
        vTaskDelay(pdMS_TO_TICKS(AFT_INTERROGATE_INTERVAL_MS));
        got_response = interrogate_aft_ack(&aft);
    }
    if (got_response) {
        if (aft.status_code == AFT_STATUS_SUCCESS || aft.status_code == AFT_STATUS_PARTIAL) {
            ESP_LOGI(TAG, "Recovery: machine already received funds, clearing NVS");
            nvs_clear_pending_txn();
        } else {
            ESP_LOGW(TAG, "Recovery: machine did NOT receive funds (status=0x%02X), will re-send",
                     aft.status_code);
            ServerCommand retry_cmd;
            retry_cmd.cmd_type = CMD_AFT_PUMP;
            retry_cmd.amount   = amount;
            strncpy(retry_cmd.txn_id, txn_id, 20);
            execute_aft_command(&retry_cmd);
        }
    }
}

// ── Main SAS polling loop ──────────────────────────────────────

void sas_polling_task(void* pvParameters) {
    ESP_LOGI(TAG, "SAS Polling Task started on Core %d", xPortGetCoreID());

    uint8_t  lp_frame[8];
    uint8_t  resp_buf[32];
    uint32_t last_credits  = 0;
    uint32_t last_coin_in  = 0;
    uint32_t last_coin_out = 0;

    // Synchronize to the machine's poll cycle (SAS 6.02 Section 3.3)
    // before anything else -- see sas_send_sync_broadcast() for why.
    // Without this, the machine ignores every poll addressed to us,
    // forever, on this single-machine bus.
    vTaskDelay(pdMS_TO_TICKS(500));
    sas_send_sync_broadcast();

    // Query the real machine's identity once, before anything else --
    // see query_machine_identity() for why. A few retries here since
    // this only needs to succeed once ever (not every boot matters as
    // much as getting it eventually), and the link may still be settling
    // right after power-up.
    for (int attempt = 0; attempt < 3 && !s_identity_known; attempt++) {
        query_machine_identity();
    }
    for (int attempt = 0; attempt < 3 && !s_denom_known; attempt++) {
        query_machine_denom();
    }
    // Lock down ticket cashout/redemption -- see configure_ticket_lockdown()
    // for why. A few retries for the same reason as the queries above.
    for (int attempt = 0; attempt < 3; attempt++) {
        if (configure_ticket_lockdown()) break;
    }

    // Check for pending transaction from previous power cycle
    recover_pending_aft();

    TickType_t last_wake = xTaskGetTickCount();

    while (true) {
        // ── 1. Check for incoming server command ────────────────
        ServerCommand cmd;
        if (xQueueReceive(g_command_queue, &cmd, 0) == pdTRUE) {
            switch (cmd.cmd_type) {
                case CMD_AFT_PUMP:
                    ESP_LOGI(TAG, "AFT IN  recv: amount=%lu credits  txn=%s",
                             (unsigned long)cmd.amount, cmd.txn_id);
                    execute_aft_command(&cmd);
                    break;
                case CMD_AFT_WITHDRAW:
                    // Added 2026-09-08 per explicit requirement: a disabled
                    // machine (admin pressed DISABLE -- LP 0x01 Shutdown +
                    // LP 0x07 Disable Bill) must not also accept an AFT
                    // withdrawal. Checked here (not just in the backend)
                    // because this firmware state is the authoritative
                    // real-time truth -- the backend's DB copy of "disabled"
                    // can be stale by up to a poll cycle.
                    if (s_state == SLOT_STATE_DISABLED) {
                        ESP_LOGW(TAG, "AFT OUT rejected: machine is DISABLED  txn=%s", cmd.txn_id);
                        report_event(SAS_EXC_AFT_TRANSFER_DONE, 0, 0, 0,
                                     AFT_STATUS_BUSY, cmd.txn_id);
                        break;
                    }
                    ESP_LOGI(TAG, "AFT OUT recv: amount=%lu credits  txn=%s",
                             (unsigned long)cmd.amount, cmd.txn_id);
                    execute_aft_command(&cmd);
                    break;
                case CMD_LOCK:
                    execute_simple_command(SAS_CMD_SHUTDOWN);
                    s_state = SLOT_STATE_TOURNAMENT_LOCKED;
                    ESP_LOGI(TAG, "LOCK: LP 0x01 Shutdown sent");
                    break;
                case CMD_UNLOCK:
                    execute_simple_command(SAS_CMD_STARTUP);
                    s_state = SLOT_STATE_IDLE;
                    ESP_LOGI(TAG, "UNLOCK: LP 0x02 Startup sent");
                    break;
                case CMD_DISABLE:
                    execute_simple_command(SAS_CMD_SHUTDOWN);
                    vTaskDelay(pdMS_TO_TICKS(40));
                    execute_simple_command(SAS_CMD_DISABLE_BILL);
                    s_state = SLOT_STATE_DISABLED;
                    ESP_LOGI(TAG, "DISABLE: LP 0x01 + LP 0x07 sent");
                    break;
                case CMD_ENABLE:
                    execute_simple_command(SAS_CMD_STARTUP);
                    vTaskDelay(pdMS_TO_TICKS(40));
                    execute_simple_command(SAS_CMD_ENABLE_BILL);
                    s_state = SLOT_STATE_IDLE;
                    ESP_LOGI(TAG, "ENABLE: LP 0x02 + LP 0x06 sent");
                    break;
                default:
                    ESP_LOGW(TAG, "Unknown command type: %d", cmd.cmd_type);
                    break;
            }
        }

        // ── 2. General Poll to get exception code ───────────────
        // EGM responds with 1 exception byte if it has one queued, or
        // stays silent (n==0) if it doesn't -- silence is the
        // NORMAL/common case per spec, not a failure, so it must NOT
        // drive the offline/retry counter. Offline detection instead
        // lives on the Credits poll below, which always requires a
        // real ACK'd, CRC-valid response.
        uint8_t exc_byte = 0;
        size_t n = sas_general_poll(g_machine_id, &exc_byte);

        uint8_t exception = (n > 0) ? exc_byte : SAS_EXC_NO_ACTIVITY;

        // ── 3. Update state machine based on exception ──────────
        switch (exception) {
            case SAS_EXC_NO_ACTIVITY:
                if (s_state == SLOT_STATE_OFFLINE || s_state == SLOT_STATE_INIT) {
                    s_state = SLOT_STATE_IDLE;
                    ESP_LOGI(TAG, "Machine online → IDLE");
                }
                break;

            case SAS_EXC_REEL_SPIN_BEGIN:
                if (s_state == SLOT_STATE_IDLE || s_state == SLOT_STATE_TOURNAMENT_LOCKED) {
                    s_state = SLOT_STATE_PLAYING;
                }
                ESP_LOGI(TAG, "EXC 0x27: Reel spin begin (game started)");
                break;

            case SAS_EXC_HANDPAY_PENDING:
                s_state = SLOT_STATE_HANDPAY;
                {
                    size_t hp_len = sas_build_lp_handpay(lp_frame, g_machine_id);
                    sas_send_frame(lp_frame, hp_len);
                    size_t hn = sas_receive(resp_buf, sizeof(resp_buf), SAS_LONG_POLL_TIMEOUT);
                    if (hn > 0) {
                        SasHandpayResponse hp = sas_parse_handpay(resp_buf, hn);
                        if (hp.valid) {
                            uint32_t hp_cents = credits_to_cents(hp.handpay_amount);
                            ESP_LOGW(TAG, "EXC 0x44: HANDPAY pending – amount=%lu ($%.2f)",
                                     (unsigned long)hp.handpay_amount,
                                     hp_cents / 100.0f);
                            report_event(exception, hp_cents, 0, 0, 0, NULL);
                        }
                    } else {
                        ESP_LOGW(TAG, "EXC 0x44: HANDPAY pending – no amount response");
                    }
                }
                break;

            default:
                if (exception != SAS_EXC_NO_ACTIVITY) {
                    ESP_LOGI(TAG, "EXC 0x%02X: %s", exception, exc_name(exception));
                    report_event(exception, last_credits, last_coin_in, last_coin_out, 0, NULL);
                }
                break;
        }

        // ── 4. Periodically poll credit meter & meters ──────────
        static uint8_t meter_tick = 0;
        if (++meter_tick >= 5) {  // every 5 cycles (~200ms)
            meter_tick = 0;

            size_t cr_len = sas_build_lp_credits(lp_frame, g_machine_id);
            sas_send_frame(lp_frame, cr_len);
            n = sas_receive(resp_buf, sizeof(resp_buf), SAS_LONG_POLL_TIMEOUT);
            SasCreditResponse cr = (n > 0) ? sas_parse_credits(resp_buf, n)
                                            : SasCreditResponse{0, false};
            if (cr.valid) {
                s_retry_count = 0;
                if (s_state == SLOT_STATE_OFFLINE || s_state == SLOT_STATE_INIT) {
                    s_state = SLOT_STATE_IDLE;
                    ESP_LOGI(TAG, "Machine online → IDLE");
                }
                uint32_t cr_cents = credits_to_cents(cr.credits);
                if (cr_cents != last_credits) {
                    int32_t delta = (int32_t)cr_cents - (int32_t)last_credits;
                    ESP_LOGI(TAG, "Credits: %lu raw (denom-converted %lu) (%+ld)  $%.2f",
                             (unsigned long)cr.credits, (unsigned long)cr_cents, (long)delta,
                             cr_cents / 100.0f);
                    last_credits = cr_cents;
                }
            } else {
                ESP_LOGW(TAG, "Credits poll: response CRC/parse error (n=%d)", (int)n);
                s_retry_count++;
                if (s_retry_count >= SAS_MAX_RETRIES && s_state != SLOT_STATE_OFFLINE) {
                    ESP_LOGW(TAG, "Machine offline – Credits poll failing");
                    s_state = SLOT_STATE_OFFLINE;
                }
            }
        }

        static uint8_t meters_tick = 0;
        if (++meters_tick >= 25) {  // every 25 cycles (~1s)
            meters_tick = 0;

            size_t m_len = sas_build_lp_meters(lp_frame, g_machine_id);
            sas_send_frame(lp_frame, m_len);
            n = sas_receive(resp_buf, sizeof(resp_buf), SAS_LONG_POLL_TIMEOUT);
            if (n > 0) {
                SasMetersResponse mr = sas_parse_meters(resp_buf, n);
                if (mr.valid) {
                    uint32_t coin_in_cents  = credits_to_cents(mr.coin_in);
                    uint32_t coin_out_cents = credits_to_cents(mr.coin_out);
                    if (coin_in_cents != last_coin_in || coin_out_cents != last_coin_out) {
                        ESP_LOGI(TAG, "Meters: coin_in=%lu ($%.2f)  coin_out=%lu ($%.2f)  played=%lu",
                                 (unsigned long)coin_in_cents,  coin_in_cents  / 100.0f,
                                 (unsigned long)coin_out_cents, coin_out_cents / 100.0f,
                                 (unsigned long)mr.games_played);
                    }
                    last_coin_in  = coin_in_cents;
                    last_coin_out = coin_out_cents;
                    report_event(SAS_EXC_NO_ACTIVITY, last_credits,
                                 last_coin_in, last_coin_out, 0, NULL);
                } else {
                    ESP_LOGW(TAG, "Meters poll: response CRC/parse error (n=%d)", (int)n);
                }
            }
        }

        // ── 5. Strict 40ms cycle boundary ───────────────────────
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(SAS_POLL_INTERVAL_MS));
    }
}

void sas_polling_task_start() {
    g_command_queue = xQueueCreate(10, sizeof(ServerCommand));
    g_report_queue  = xQueueCreate(50, sizeof(MachineEvent));

    xTaskCreatePinnedToCore(
        sas_polling_task,
        "SAS_POLL",
        TASK_STACK_SAS,
        NULL,
        configMAX_PRIORITIES - 1,  // Highest priority – preempts MQTT task on this single core
        NULL,
        0                          // Core 0 (ESP32-C3 is single-core)
    );
}

SlotState sas_get_state() {
    return s_state;
}

bool sas_identity_known() {
    return s_identity_known;
}

const char* sas_get_serial_number() {
    return s_serial_number;
}

bool sas_denom_known() {
    return s_denom_known;
}

uint8_t sas_get_denom_code() {
    return s_denom_code;
}

uint32_t sas_get_denom_value_x10000() {
    return s_denom_value_x10000;
}

const char* sas_get_sas_version() {
    return s_sas_version;
}
