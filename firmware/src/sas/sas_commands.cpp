// =============================================================
// sas_commands.cpp – SAS 6.0x Long Poll frame builders & parsers
// =============================================================
#include "sas_commands.h"
#include "crc16.h"
#include "../../include/config.h"
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

// Field layout verified 2026-09-05 against SASPyTourney/saspy (see
// sas_commands.h doc comment on sas_build_lp_aft for the full byte
// map and why the old 6-field version failed on real hardware).
size_t sas_build_lp_aft(uint8_t* buf, uint8_t address,
                         uint8_t transfer_code, uint8_t transfer_type,
                         uint32_t amount_credits, const char* txn_id,
                         uint32_t asset_number, const uint8_t* registration_key) {
    size_t idx = 0;

    buf[idx++] = address;              // Address (MARK parity)
    buf[idx++] = SAS_CMD_AFT_TRANSFER;  // 0x72

    size_t len_pos = idx++;            // Length -- filled in after payload is built

    buf[idx++] = transfer_code;        // Transfer Code
    buf[idx++] = 0x00;                 // Transaction Index -- always 0 for a new transfer
    buf[idx++] = transfer_type;        // Transfer Type

    // Cashable / Restricted / Non-restricted amounts -- 5-byte BCD each.
    // amount_credits goes into whichever bucket transfer_type selects;
    // the other two stay zero (a transfer is always exactly one type).
    uint32_t cashable_amt      = (transfer_type == AFT_TYPE_CASHABLE)      ? amount_credits : 0;
    uint32_t restricted_amt    = (transfer_type == AFT_TYPE_RESTRICTED)    ? amount_credits : 0;
    uint32_t nonrestricted_amt = (transfer_type == AFT_TYPE_NONRESTRICTED) ? amount_credits : 0;
    uint32_to_bcd(cashable_amt,      &buf[idx], 5); idx += 5;
    uint32_to_bcd(restricted_amt,    &buf[idx], 5); idx += 5;
    uint32_to_bcd(nonrestricted_amt, &buf[idx], 5); idx += 5;

    buf[idx++] = 0x00;                 // Transfer Flags -- no lock/receipt requested

    // Asset Number (4 bytes, big-endian/MSB-first) -- must be the value
    // obtained from a successful LP 0x73 registration, not a guess: a
    // confirmed-correct asset number still got rejected with status 0x93
    // when the Registration Key below was all-zero (confirmed 2026-09-05
    // -- see sas_build_lp_aft_register()).
    buf[idx++] = (uint8_t)(asset_number >> 24);
    buf[idx++] = (uint8_t)(asset_number >> 16);
    buf[idx++] = (uint8_t)(asset_number >> 8);
    buf[idx++] = (uint8_t)(asset_number);

    // Registration Key (20 bytes) -- from the same LP 0x73 registration.
    memcpy(&buf[idx], registration_key, 20);
    idx += 20;

    // Transaction ID: 1-byte length prefix + up to 20 ASCII bytes.
    size_t txn_len = strnlen(txn_id, 20);
    buf[idx++] = (uint8_t)txn_len;
    memcpy(&buf[idx], txn_id, txn_len);
    idx += txn_len;

    // Expiration (4-byte BCD, unused -- not a ticket transfer)
    memset(&buf[idx], 0x00, 4); idx += 4;
    // Pool ID (2 bytes, unused)
    memset(&buf[idx], 0x00, 2); idx += 2;
    // Receipt Data length (0 -- no receipt requested)
    buf[idx++] = 0x00;
    // Lock Timeout (2 bytes, unused -- Transfer Flags didn't request a lock)
    memset(&buf[idx], 0x00, 2); idx += 2;

    buf[len_pos] = (uint8_t)(idx - 3);  // length excludes addr, cmd, and the length byte itself

    crc16_append(buf, idx);
    return idx + 2;
}

SasAftResponse sas_parse_aft(const uint8_t* buf, size_t len) {
    SasAftResponse resp = {0xFF, 0, 0, 0, 0, 0, 0, 0, "", false};
    // Minimum frame to reach the transfer status byte + CRC.
    if (len < 7) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_AFT_TRANSFER) return resp;

    resp.transfer_buffer_pos = buf[3];
    resp.status_code         = buf[4];
    resp.receipt_status      = buf[5];
    resp.transfer_type       = buf[6];

    if (len >= 22) {
        resp.cashable_amount      = bcd_to_uint32(&buf[7],  5);
        resp.restricted_amount    = bcd_to_uint32(&buf[12], 5);
        resp.nonrestricted_amount = bcd_to_uint32(&buf[17], 5);
        resp.transfer_amount = resp.cashable_amount + resp.restricted_amount
                             + resp.nonrestricted_amount;
    }

    // Transfer Flags(1) + Asset Number(4) = buf[22..26], then Txn ID Length(1) at buf[27]
    if (len >= 29) {
        size_t txn_len = buf[27];
        if (txn_len > 20) txn_len = 20;
        size_t txn_end = len - 2;  // strip CRC
        if (28 + txn_len > txn_end) txn_len = (txn_end > 28) ? (txn_end - 28) : 0;
        memcpy(resp.transaction_id, &buf[28], txn_len);
        resp.transaction_id[txn_len] = '\0';
    }

    resp.valid = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 73 – AFT Register Gaming Machine
//
// Field layout verified 2026-09-05 against SASPyTourney/saspy's
// aft_register_gaming_machine(): a bare query (reg_code==QUERY) sends
// just the reg_code byte (length=1); an actual register/unregister
// sends reg_code + asset_number(4) + registration_key(20) + pos_id(4)
// (length=29=0x1D). The response mirrors that: status(1) + asset(4) +
// key(20) + pos_id(4) = 29 bytes of payload, always sent in full
// (confirmed via that library's fixed size=34 read for this poll).
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_aft_register(uint8_t* buf, uint8_t address, uint8_t reg_code,
                                  uint32_t asset_number, const uint8_t* registration_key,
                                  uint32_t pos_id) {
    size_t idx = 0;

    buf[idx++] = address;
    buf[idx++] = SAS_CMD_AFT_REGISTER;  // 0x73

    size_t len_pos = idx++;

    buf[idx++] = reg_code;

    if (reg_code != AFT_REG_CODE_QUERY) {
        buf[idx++] = (uint8_t)(asset_number >> 24);
        buf[idx++] = (uint8_t)(asset_number >> 16);
        buf[idx++] = (uint8_t)(asset_number >> 8);
        buf[idx++] = (uint8_t)(asset_number);

        memcpy(&buf[idx], registration_key, 20);
        idx += 20;

        buf[idx++] = (uint8_t)(pos_id >> 24);
        buf[idx++] = (uint8_t)(pos_id >> 16);
        buf[idx++] = (uint8_t)(pos_id >> 8);
        buf[idx++] = (uint8_t)(pos_id);
    }

    buf[len_pos] = (uint8_t)(idx - 3);

    crc16_append(buf, idx);
    return idx + 2;
}

SasAftRegisterResponse sas_parse_aft_register(const uint8_t* buf, size_t len) {
    SasAftRegisterResponse resp = {0xFF, 0, {0}, false};
    // Minimum frame to reach the registration status byte + CRC.
    if (len < 6) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_AFT_REGISTER) return resp;

    resp.status_code = buf[3];

    if (len >= 30) {
        resp.asset_number = ((uint32_t)buf[4] << 24) | ((uint32_t)buf[5] << 16)
                           | ((uint32_t)buf[6] << 8)  | (uint32_t)buf[7];
        memcpy(resp.registration_key, &buf[8], 20);
    }

    resp.valid = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 54 – Send SAS Version ID and Gaming Machine Serial Number
//
// Response: [addr][0x54][length][SAS version:3 ASCII]["serial number
// length":1][serial number: N ASCII][CRC_L][CRC_H], following this
// project's own established convention (confirmed against Credits/AFT
// on real hardware) that byte[2] is always the frame's length field,
// not yet stripped -- unlike some third-party libraries' response
// handling, which strip it before handing data to the caller.
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_version_serial(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_SEND_VERSION_SERIAL;
    crc16_append(buf, 2);
    return 4;
}

SasVersionSerialResponse sas_parse_version_serial(const uint8_t* buf, size_t len) {
    SasVersionSerialResponse resp = {{0}, {0}, false};
    // Minimum frame: addr, cmd, length, 3-byte version, 1-byte serial
    // length, 2-byte CRC.
    if (len < 7) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_SEND_VERSION_SERIAL) return resp;

    memcpy(resp.sas_version, &buf[3], 3);
    resp.sas_version[3] = '\0';

    size_t serial_len = buf[6];
    if (serial_len > 40) serial_len = 40;
    size_t serial_end = len - 2;  // strip CRC
    if (7 + serial_len > serial_end) {
        serial_len = (serial_end > 7) ? (serial_end - 7) : 0;
    }
    memcpy(resp.serial_number, &buf[7], serial_len);
    resp.serial_number[serial_len] = '\0';

    resp.valid = true;
    return resp;
}
