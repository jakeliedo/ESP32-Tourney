// =============================================================
// sas_commands.cpp – SAS 6.0x Long Poll frame builders & parsers
// =============================================================
#include "sas_commands.h"
#include "crc16.h"
#include <string.h>
#include <stdio.h>

// ─────────────────────────────────────────────────────────────
// BCD helpers
// ─────────────────────────────────────────────────────────────

uint32_t bcd_to_uint32(const uint8_t* bcd, size_t bytes) {
    uint32_t result = 0;
    for (size_t i = 0; i < bytes; i++) {
        result = result * 100 + ((bcd[i] >> 4) & 0x0F) * 10 + (bcd[i] & 0x0F);
    }
    return result;
}

void uint32_to_bcd(uint32_t value, uint8_t* bcd, size_t bytes) {
    for (int i = (int)bytes - 1; i >= 0; i--) {
        bcd[i] = (uint8_t)(((value % 10)) | (((value / 10) % 10) << 4));
        value /= 100;
    }
}

// ─────────────────────────────────────────────────────────────
// Type-S Long Poll — Shutdown / Startup / Enable|Disable Bill
// Format: [ADDR(MARK)] [CMD(SPACE)] [CRC_L(SPACE)] [CRC_H(SPACE)]
// Response: [ADDR] = ACK  |  [ADDR | 0x80] = NACK
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_simple(uint8_t* buf, uint8_t address, uint8_t cmd) {
    buf[0] = address;
    buf[1] = cmd;
    crc16_append(buf, 2);
    return 4;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 1A – Send Current Credit Meter
// Request:  [ADDR(MARK)] [0x1A(SPACE)] [CRC_L] [CRC_H]
// Response: [ADDR] [0x1A] [BCD_4_BYTES] [CRC_L] [CRC_H]
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_credits(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_SEND_CREDITS;
    crc16_append(buf, 2);
    return 4;
}

SasCreditResponse sas_parse_credits(const uint8_t* buf, size_t len) {
    SasCreditResponse resp = {0, false};
    if (len < 8) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_SEND_CREDITS) return resp;

    resp.credits = bcd_to_uint32(&buf[2], 4);
    resp.valid   = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 1B – Send Handpay Information
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_handpay(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_SEND_HANDPAY;
    crc16_append(buf, 2);
    return 4;
}

SasHandpayResponse sas_parse_handpay(const uint8_t* buf, size_t len) {
    SasHandpayResponse resp = {0, 0, false};
    if (len < 10) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_SEND_HANDPAY) return resp;

    resp.handpay_amount = bcd_to_uint32(&buf[2], 4);
    resp.type           = buf[6];
    resp.valid          = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll AF – Extended Meters
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_meters(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_METERS_POLL;
    crc16_append(buf, 2);
    return 4;
}

SasMetersResponse sas_parse_meters(const uint8_t* buf, size_t len) {
    SasMetersResponse resp = {0, 0, 0, false};
    if (len < 16) return resp;
    if (!crc16_verify(buf, len)) return resp;

    resp.coin_in      = bcd_to_uint32(&buf[2], 4);
    resp.coin_out     = bcd_to_uint32(&buf[6], 4);
    resp.games_played = bcd_to_uint32(&buf[10], 4);
    resp.valid        = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 72 – AFT Initiate Transfer
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_aft(uint8_t* buf, uint8_t address,
                         uint8_t transfer_code, uint8_t transfer_type,
                         uint32_t amount_credits, const char* txn_id) {
    size_t idx = 0;

    buf[idx++] = address;           // Byte 1: Address (MARK parity)
    buf[idx++] = SAS_CMD_AFT_TRANSFER; // Byte 2: Command 0x72

    // Byte 3: length placeholder – will fill after building payload
    size_t len_pos = idx++;

    buf[idx++] = transfer_code;     // Byte 4: Transfer Code
    buf[idx++] = 0x00;              // Byte 5: Transfer Index
    buf[idx++] = transfer_type;     // Byte 6: Transfer Type

    // Bytes 7-10: Amount in BCD (4 bytes)
    uint32_to_bcd(amount_credits, &buf[idx], 4);
    idx += 4;

    // Bytes 11-14: Date MMDDYYYY (static placeholder; set by caller if needed)
    buf[idx++] = 0x01; buf[idx++] = 0x01;  // MM DD
    buf[idx++] = 0x20; buf[idx++] = 0x26;  // 2026

    // Bytes 15-18: Time HHMMSS (static placeholder)
    buf[idx++] = 0x00; buf[idx++] = 0x00; buf[idx++] = 0x00; buf[idx++] = 0x00;

    // Transaction ID: up to 20 ASCII bytes
    size_t txn_len = strnlen(txn_id, 20);
    memcpy(&buf[idx], txn_id, txn_len);
    idx += txn_len;

    // Fill length byte (payload between command and CRC)
    buf[len_pos] = (uint8_t)(idx - 3);  // exclude addr, cmd, len itself

    crc16_append(buf, idx);
    return idx + 2;
}

SasAftResponse sas_parse_aft(const uint8_t* buf, size_t len) {
    SasAftResponse resp = {0xFF, 0, "", false};
    if (len < 6) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_AFT_TRANSFER) return resp;

    resp.status_code     = buf[3];
    resp.transfer_amount = bcd_to_uint32(&buf[4], 4);

    // Transaction ID extraction (varies by machine response length)
    size_t txn_start = 8;
    size_t txn_end   = len >= 3 ? len - 2 : len;  // strip CRC
    if (txn_start < txn_end) {
        size_t txn_len = txn_end - txn_start;
        if (txn_len > 20) txn_len = 20;
        memcpy(resp.transaction_id, &buf[txn_start], txn_len);
        resp.transaction_id[txn_len] = '\0';
    }

    resp.valid = true;
    return resp;
}
