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
}

/**
 * Transmit a Long Poll frame with the real-hardware-verified wakeup
 * preamble (per SASPyTourney/saspy): [SAS_POLL_ADDRESS(MARK), frame[0]
 * i.e. machine address(MARK)], then the rest of frame (cmd/data/CRC)
 * as SPACE. A plain single MARK address byte (this firmware's earlier
 * approach) got ignored/echoed by real machines instead of routing
 * the poll. Always runs at 1 stop bit (restored here in case the
 * General Poll path above left the UART at 2 stop bits).
 */
static void sas_send_frame(const uint8_t* frame, size_t len) {
    uart_set_stop_bits(SAS_UART_NUM, UART_STOP_BITS_1);
    uart_flush(SAS_UART_NUM);
#if SAS_LOG_RAW_FRAMES
    uint8_t logged[34];
    logged[0] = SAS_POLL_ADDRESS;
    memcpy(logged + 1, frame, len < 33 ? len : 33);
    hex_dump("SAS TX", logged, len + 1);
#endif
    sas_send_byte(SAS_POLL_ADDRESS, true);
    sas_send_byte(frame[0], true);          // machine address – MARK
    for (size_t i = 1; i < len; i++) {
        sas_send_byte(frame[i], false);     // cmd/data/CRC – SPACE
    }
}

/**
 * General Poll ("events poll"), per SASPyTourney/saspy real-hardware
 * framing: NO parity bit at all (not even our usual bit9 MARK/SPACE
 * emulation) and 2 STOP BITS, sending 2 plain 8-bit bytes:
 * [SAS_POLL_ADDRESS, 0x80 | machine_address]. The earlier approach
 * (bit9 MARK on a single machine-address byte, 1 stop bit) always got
 * echoed back unchanged by the real machine instead of a genuine
 * exception report. Returns 1 if an exception byte was read into
 * *out_exc, 0 on timeout (no exception queued -- the normal case).
 */
static size_t sas_general_poll(uint8_t machine_address, uint8_t* out_exc) {
    uart_set_parity(SAS_UART_NUM, UART_PARITY_DISABLE);
    uart_set_stop_bits(SAS_UART_NUM, UART_STOP_BITS_2);
    uart_flush(SAS_UART_NUM);

    uint8_t frame[2] = { SAS_POLL_ADDRESS, (uint8_t)(0x80 | machine_address) };
#if SAS_LOG_RAW_FRAMES
    hex_dump("SAS TX(gp)", frame, 2);
#endif
    uart_write_bytes(SAS_UART_NUM, (const char*)frame, 2);
    uart_wait_tx_done(SAS_UART_NUM, pdMS_TO_TICKS(10));

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
        if (n > 0) received += n;
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
        if (n > 0) received += n;
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

// ── AFT execution ──────────────────────────────────────────────

static void execute_aft_command(const ServerCommand* cmd) {
    uint8_t frame[32];
    uint8_t resp[32];

    // Persist before sending (power-fail safety)
    nvs_save_pending_txn(cmd->txn_id, cmd->amount);

    uint8_t transfer_code = (cmd->cmd_type == CMD_AFT_WITHDRAW)
                                ? AFT_CODE_TRANSFER_PARTIAL
                                : AFT_CODE_TRANSFER_FULL;
    uint8_t transfer_type = (cmd->cmd_type == CMD_AFT_PUMP)
                                ? AFT_TYPE_CASHABLE
                                : AFT_TYPE_RESTRICTED;

    size_t frame_len = sas_build_lp_aft(frame, g_machine_id,
                                         transfer_code, transfer_type,
                                         cmd->amount, cmd->txn_id);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);

    if (n > 0) {
        SasAftResponse aft = sas_parse_aft(resp, n);
        if (aft.valid) {
            if (aft.status_code == AFT_STATUS_SUCCESS) {
                nvs_clear_pending_txn();
                ESP_LOGI(TAG, "AFT OK: transferred %lu credits  txn=%s",
                         (unsigned long)aft.transfer_amount, cmd->txn_id);
            } else {
                ESP_LOGW(TAG, "AFT FAIL: status=0x%02X  txn=%s",
                         aft.status_code, cmd->txn_id);
            }
            report_event(SAS_EXC_AFT_TRANSFER_DONE, 0, 0, 0,
                         aft.status_code, cmd->txn_id);
        } else {
            ESP_LOGW(TAG, "AFT: response CRC/parse error  n=%d  txn=%s",
                     (int)n, cmd->txn_id);
        }
    } else {
        ESP_LOGW(TAG, "AFT: no response from machine (n=0)  txn=%s", cmd->txn_id);
    }
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

    // Interrogate the machine to see if it already received the funds
    uint8_t frame[32], resp[32];
    size_t frame_len = sas_build_lp_aft(frame, g_machine_id,
                                         AFT_CODE_INTERROGATE, AFT_TYPE_CASHABLE,
                                         0, txn_id);
    sas_send_frame(frame, frame_len);
    size_t n = sas_receive(resp, sizeof(resp), SAS_LONG_POLL_TIMEOUT);
    if (n > 0) {
        SasAftResponse aft = sas_parse_aft(resp, n);
        if (aft.valid && aft.status_code == AFT_STATUS_SUCCESS) {
            ESP_LOGI(TAG, "Recovery: machine already received funds, clearing NVS");
            nvs_clear_pending_txn();
        } else {
            ESP_LOGW(TAG, "Recovery: machine did NOT receive funds, will re-send");
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

    // Check for pending transaction from previous power cycle
    vTaskDelay(pdMS_TO_TICKS(500));
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
                            ESP_LOGW(TAG, "EXC 0x44: HANDPAY pending – amount=%lu ($%.2f)",
                                     (unsigned long)hp.handpay_amount,
                                     hp.handpay_amount / 100.0f);
                            report_event(exception, hp.handpay_amount, 0, 0, 0, NULL);
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
                if (cr.credits != last_credits) {
                    int32_t delta = (int32_t)cr.credits - (int32_t)last_credits;
                    ESP_LOGI(TAG, "Credits: %lu (%+ld)  $%.2f",
                             (unsigned long)cr.credits, (long)delta,
                             cr.credits / 100.0f);
                    last_credits = cr.credits;
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
                    if (mr.coin_in != last_coin_in || mr.coin_out != last_coin_out) {
                        ESP_LOGI(TAG, "Meters: coin_in=%lu ($%.2f)  coin_out=%lu ($%.2f)  played=%lu",
                                 (unsigned long)mr.coin_in,  mr.coin_in  / 100.0f,
                                 (unsigned long)mr.coin_out, mr.coin_out / 100.0f,
                                 (unsigned long)mr.games_played);
                    }
                    last_coin_in  = mr.coin_in;
                    last_coin_out = mr.coin_out;
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
