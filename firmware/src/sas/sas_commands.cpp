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
// Long Poll 11 – Send Total Coin In Meter (Section 7.1, single meter)
// Request:  [ADDR(MARK)] [0x11(SPACE)] [CRC_L] [CRC_H]
// Response: [ADDR] [0x11] [BCD_4_BYTES] [CRC_L] [CRC_H]
// Identical frame shape to LP 0x1A -- lifetime/cumulative meter, never
// resets, host must snapshot-and-diff per round (see sas_polling.cpp).
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_total_coin_in(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_SEND_TOTAL_COIN_IN;
    crc16_append(buf, 2);
    return 4;
}

SasTotalCoinInResponse sas_parse_total_coin_in(const uint8_t* buf, size_t len) {
    SasTotalCoinInResponse resp = {0, false};
    if (len < 8) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_SEND_TOTAL_COIN_IN) return resp;

    resp.coin_in = bcd_to_uint32(&buf[2], 4);
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
// Long Poll AF – Extended Meters (Alternate)
//
// Fixed 2026-09-10: the previous implementation sent a bare 4-byte frame
// ([addr][0xAF][CRC]) with NO payload at all. LP 0xAF/0x6F are variable-
// length commands (Section 7.21, Table 7.21a/7.21b) that REQUIRE a
// length byte, a 2-BCD game_number, and an explicit list of 2-byte meter
// codes (see Table C-7, Appendix C) -- the machine has no way to know
// which meters are being asked for from a bare 4-byte poll, so it almost
// certainly silently ignored every request. This is very likely the real
// reason this project's test machine "never responded to Meters" (first
// noted 2026-09-05) -- not a hardware/firmware limitation on the
// machine's side at all.
//
// Request:  [ADDR(MARK)] [0xAF] [length] [game_number:2 BCD]
//           [meter_code:2 binary]... [CRC_L] [CRC_H]
// Response: [ADDR] [0xAF] [length] [game_number:2 BCD]
//           {[meter_code:2 binary][size:1][value:size BCD]}... [CRC_L] [CRC_H]
//
// Meter codes are "2 binary" per Table 7.21a -- LSB-first per Section
// 2.2.3 (the same binary-field byte-order rule as AFT's Asset Number/POS
// ID), NOT BCD/ASCII. game_number is BCD; 0000 = "the gaming machine"
// (terminal-wide), not a specific game. We request exactly the 3 meters
// this project actually uses: 0x0000 Total Coin In, 0x0001 Total Coin
// Out, 0x0005 Games Played (codes per Table C-7).
// ─────────────────────────────────────────────────────────────

#define SAS_METER_CODE_COIN_IN      0x0000
#define SAS_METER_CODE_COIN_OUT     0x0001
#define SAS_METER_CODE_GAMES_PLAYED 0x0005

size_t sas_build_lp_meters(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_METERS_POLL;

    size_t idx = 3;             // buf[2] = length, filled in below
    buf[idx++] = 0x00;          // game_number (2 BCD) = 0000 -- gaming machine, not a specific game
    buf[idx++] = 0x00;

    // Meter codes, 2 binary each, LSB-first (low byte, then high byte)
    buf[idx++] = (uint8_t)(SAS_METER_CODE_COIN_IN);
    buf[idx++] = (uint8_t)(SAS_METER_CODE_COIN_IN >> 8);
    buf[idx++] = (uint8_t)(SAS_METER_CODE_COIN_OUT);
    buf[idx++] = (uint8_t)(SAS_METER_CODE_COIN_OUT >> 8);
    buf[idx++] = (uint8_t)(SAS_METER_CODE_GAMES_PLAYED);
    buf[idx++] = (uint8_t)(SAS_METER_CODE_GAMES_PLAYED >> 8);

    buf[2] = (uint8_t)(idx - 3);  // length excludes addr, cmd, and the length byte itself

    crc16_append(buf, idx);
    return idx + 2;
}

SasMetersResponse sas_parse_meters(const uint8_t* buf, size_t len) {
    SasMetersResponse resp = {0, 0, 0, false};
    // Minimum: addr+cmd+length+game_number(2)+CRC(2) = 7, even with zero meters returned.
    if (len < 7) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_METERS_POLL) return resp;

    uint8_t declared_len = buf[2];
    size_t  payload_end  = 3 + declared_len;      // end of game_number+meters, right before CRC
    size_t  actual_end   = len - 2;                // CRC is always the last 2 bytes actually received
    if (payload_end > actual_end) payload_end = actual_end;  // defensive clamp

    size_t idx = 3 + 2;  // skip addr,cmd,length + game_number(2 BCD) -- start of first code/size/value triple
    bool got_any = false;

    while (idx + 3 <= payload_end) {
        uint16_t code = (uint16_t)buf[idx] | ((uint16_t)buf[idx + 1] << 8);  // LSB-first
        uint8_t  size = buf[idx + 2];
        idx += 3;
        if (idx + size > payload_end) break;  // malformed/truncated -- stop parsing safely

        uint32_t value = (size > 0) ? bcd_to_uint32(&buf[idx], size) : 0;
        idx += size;

        switch (code) {
            case SAS_METER_CODE_COIN_IN:      resp.coin_in      = value; got_any = true; break;
            case SAS_METER_CODE_COIN_OUT:     resp.coin_out     = value; got_any = true; break;
            case SAS_METER_CODE_GAMES_PLAYED: resp.games_played = value; got_any = true; break;
            default: break;  // meter we didn't ask about -- ignore
        }
    }

    resp.valid = got_any;
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
                         uint8_t amount_category, uint32_t amount_credits,
                         const char* txn_id,
                         uint32_t asset_number, const uint8_t* registration_key) {
    size_t idx = 0;

    buf[idx++] = address;              // Address (MARK parity)
    buf[idx++] = SAS_CMD_AFT_TRANSFER;  // 0x72

    size_t len_pos = idx++;            // Length -- filled in after payload is built

    buf[idx++] = transfer_code;        // Transfer Code
    buf[idx++] = 0x00;                 // Transaction Index -- always 0 for a new transfer
    buf[idx++] = transfer_type;        // Transfer Type (AFT_XFER_*, Table 8.3d)

    // Cashable / Restricted / Non-restricted amounts -- 5-byte BCD each.
    // amount_credits goes into whichever bucket amount_category selects;
    // the other two stay zero (a transfer is always exactly one category).
    uint32_t cashable_amt      = (amount_category == AFT_AMOUNT_CASHABLE)      ? amount_credits : 0;
    uint32_t restricted_amt    = (amount_category == AFT_AMOUNT_RESTRICTED)    ? amount_credits : 0;
    uint32_t nonrestricted_amt = (amount_category == AFT_AMOUNT_NONRESTRICTED) ? amount_credits : 0;
    uint32_to_bcd(cashable_amt,      &buf[idx], 5); idx += 5;
    uint32_to_bcd(restricted_amt,    &buf[idx], 5); idx += 5;
    uint32_to_bcd(nonrestricted_amt, &buf[idx], 5); idx += 5;

    buf[idx++] = 0x00;                 // Transfer Flags -- no lock/receipt requested

    // Asset Number (4 bytes). Per SAS 6.02 Section 2.2.3: "All data
    // exchanged in the binary format are sent least significant byte
    // (LSB) first" -- this field is "4 binary", so LSB first, NOT
    // MSB-first as a prior version of this firmware sent it. Must be the
    // value obtained from a successful LP 0x73 query/registration, not a
    // guess: a confirmed-correct asset number still got rejected with
    // status 0x93 when the Registration Key below was all-zero
    // (confirmed 2026-09-05 -- see sas_build_lp_aft_register()).
    buf[idx++] = (uint8_t)(asset_number);
    buf[idx++] = (uint8_t)(asset_number >> 8);
    buf[idx++] = (uint8_t)(asset_number >> 16);
    buf[idx++] = (uint8_t)(asset_number >> 24);

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
        // LSB-first: both fields are "binary" per Section 2.2.3, not BCD/ASCII.
        buf[idx++] = (uint8_t)(asset_number);
        buf[idx++] = (uint8_t)(asset_number >> 8);
        buf[idx++] = (uint8_t)(asset_number >> 16);
        buf[idx++] = (uint8_t)(asset_number >> 24);

        memcpy(&buf[idx], registration_key, 20);
        idx += 20;

        buf[idx++] = (uint8_t)(pos_id);
        buf[idx++] = (uint8_t)(pos_id >> 8);
        buf[idx++] = (uint8_t)(pos_id >> 16);
        buf[idx++] = (uint8_t)(pos_id >> 24);
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
        // LSB-first per Section 2.2.3 ("binary" field, not BCD/ASCII).
        resp.asset_number = (uint32_t)buf[4] | ((uint32_t)buf[5] << 8)
                           | ((uint32_t)buf[6] << 16) | ((uint32_t)buf[7] << 24);
        memcpy(resp.registration_key, &buf[8], 20);
    }

    resp.valid = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 1F – Send Gaming Machine ID and Information
//
// Field layout per SAS 6.02 Table 7.10 (confirmed 2026-09-08 against the
// official spec PDF, pdftotext-extracted for exact field order since the
// table's own two-column layout otherwise misleads on which bytes hold
// what -- the "Description" column is offset by one row from "Field" in
// the source PDF's rendering, easy to misread as a table for a different
// long poll entirely):
//   [addr][0x1F][Game ID:2 ASCII][Additional ID:3 ASCII]
//   [Denomination:1 binary][Max bet:1 binary][Progressive Group:2 binary]
//   [Game options:6 ASCII][Paytable ID:4 ASCII][Base%:2 binary]
//   [CRC_L][CRC_H]
// Spec total = 25 bytes, BUT the real EGT machine tested 2026-09-08 sends
// only 24 -- one byte short somewhere after Denomination (brute-force CRC
// check across candidate lengths confirmed the frame is complete and
// valid at exactly 24 bytes, not corrupt/truncated; likely a 1-byte
// Base% field on this implementation instead of the spec's 2). This
// doesn't affect Denomination, which sits at a fixed offset (7) reached
// identically in both layouts. Only check length/CRC against the ACTUAL
// received len (not a hardcoded 25) so both this machine and a
// full-spec-conformant one parse correctly.
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_machine_info(uint8_t* buf, uint8_t address) {
    buf[0] = address;
    buf[1] = SAS_CMD_SEND_MACHINE_INFO;
    crc16_append(buf, 2);
    return 4;
}

SasMachineInfoResponse sas_parse_machine_info(const uint8_t* buf, size_t len) {
    SasMachineInfoResponse resp = {0, 0, false};
    if (len < 8) return resp;  // enough to safely reach buf[7] (Denomination)
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_SEND_MACHINE_INFO) return resp;

    resp.denom_code         = buf[7];
    resp.denom_value_x10000 = sas_denom_code_to_value_x10000(resp.denom_code);
    resp.valid = true;
    return resp;
}

// Table C-4, Appendix C (verified 2026-09-08 directly against the official
// SAS 6.02 spec PDF). Values are dollars * 10000 so the fractional-cent
// codes (0x1B-0x1F) stay exact integers instead of needing floating point.
// Index = denom_code (0x00-0x1F defined; 0x20-0xFF reserved -> 0/unknown).
static const uint32_t s_denom_table_x10000[32] = {
    /* 0x00 none    */ 0,
    /* 0x01 $0.01   */ 100,
    /* 0x02 $0.05   */ 500,
    /* 0x03 $0.10   */ 1000,
    /* 0x04 $0.25   */ 2500,
    /* 0x05 $0.50   */ 5000,
    /* 0x06 $1.00   */ 10000,
    /* 0x07 $5.00   */ 50000,
    /* 0x08 $10.00  */ 100000,
    /* 0x09 $20.00  */ 200000,
    /* 0x0A $100.00 */ 1000000,
    /* 0x0B $0.20   */ 2000,
    /* 0x0C $2.00   */ 20000,
    /* 0x0D $2.50   */ 25000,
    /* 0x0E $25.00  */ 250000,
    /* 0x0F $50.00  */ 500000,
    /* 0x10 $200.00 */ 2000000,
    /* 0x11 $250.00 */ 2500000,
    /* 0x12 $500.00 */ 5000000,
    /* 0x13 $1000   */ 10000000,
    /* 0x14 $2000   */ 20000000,
    /* 0x15 $2500   */ 25000000,
    /* 0x16 $5000   */ 50000000,
    /* 0x17 $0.02   */ 200,
    /* 0x18 $0.03   */ 300,
    /* 0x19 $0.15   */ 1500,
    /* 0x1A $0.40   */ 4000,
    /* 0x1B $0.005  */ 50,
    /* 0x1C $0.0025 */ 25,
    /* 0x1D $0.002  */ 20,
    /* 0x1E $0.001  */ 10,
    /* 0x1F $0.0005 */ 5,
};

uint32_t sas_denom_code_to_value_x10000(uint8_t denom_code) {
    if (denom_code >= 32) return 0;
    return s_denom_table_x10000[denom_code];
}

// ─────────────────────────────────────────────────────────────
// Long Poll 74 – AFT Game Lock and Status Request
//
// Field layout per SAS 6.02 Table 8.2a (request) / Table 8.2b (response),
// confirmed 2026-09-08 against the official spec PDF. Response:
//   [addr][0x74][len]
//   [asset_number:4][game_lock_status:1][available_transfers:1]
//   [host_cashout_status:1][aft_status:1][max_buffer_index:1]
//   [current_cashable_amount:5 BCD][current_restricted_amount:5 BCD]
//   [current_nonrestricted_amount:5 BCD][transfer_limit:5 BCD]
//   [restricted_expiration:4 BCD][restricted_pool_id:2][CRC_L][CRC_H]
// Total response = 40 bytes. Added specifically to read
// current_cashable_amount, which Table 8.2b states is "in cents" already
// (unlike the LP 0x1A credit meter, which is in accounting-denom units)
// -- see AFT_WITHDRAW fix in sas_polling.cpp for why this matters.
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_aft_lock_status(uint8_t* buf, uint8_t address, uint8_t lock_code,
                                     uint8_t transfer_condition, uint16_t lock_timeout) {
    buf[0] = address;
    buf[1] = SAS_CMD_AFT_LOCK_STATUS;
    buf[2] = lock_code;
    buf[3] = transfer_condition;
    uint32_to_bcd(lock_timeout, &buf[4], 2);
    crc16_append(buf, 6);
    return 8;
}

SasAftLockStatusResponse sas_parse_aft_lock_status(const uint8_t* buf, size_t len) {
    SasAftLockStatusResponse resp = {0, 0xFF, 0, 0, 0, 0, 0, 0, false};
    if (len < 40) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_AFT_LOCK_STATUS) return resp;

    // Asset number here is plain "4 binary" per Table 8.2b, same LSB-first
    // rule as the LP 0x72/0x73 asset number fields (Section 2.2.3).
    resp.asset_number = (uint32_t)buf[3] | ((uint32_t)buf[4] << 8)
                       | ((uint32_t)buf[5] << 16) | ((uint32_t)buf[6] << 24);
    resp.game_lock_status    = buf[7];
    resp.available_transfers = buf[8];
    resp.host_cashout_status = buf[9];
    resp.aft_status          = buf[10];
    resp.current_cashable_amount      = bcd_to_uint32(&buf[12], 5);
    resp.current_restricted_amount    = bcd_to_uint32(&buf[17], 5);
    resp.current_nonrestricted_amount = bcd_to_uint32(&buf[22], 5);
    resp.valid = true;
    return resp;
}

// ─────────────────────────────────────────────────────────────
// Long Poll 7B – Extended Validation Status
//
// Field layout per SAS 6.02 Table 15.2a (request) / Table 15.2b (response),
// confirmed 2026-09-08 against the official spec PDF (Section 15.2).
// control_mask/status_bits are "2 binary" fields -- the spec's own bit
// table for them is literally captioned "Byte LSB / MSB", so they follow
// the same LSB-first convention as every other multi-byte "binary" field
// in SAS (Section 2.2.3), transmitted low byte first.
// ─────────────────────────────────────────────────────────────

size_t sas_build_lp_validation_status(uint8_t* buf, uint8_t address,
                                       uint16_t control_mask, uint16_t status_bits,
                                       uint16_t cashable_exp_days, uint16_t restricted_exp_days) {
    buf[0] = address;
    buf[1] = SAS_CMD_EXT_VALIDATION_STATUS;
    buf[2] = 0x08;  // length: 8 bytes follow, not including CRC

    buf[3] = (uint8_t)(control_mask);        // LSB
    buf[4] = (uint8_t)(control_mask >> 8);   // MSB
    buf[5] = (uint8_t)(status_bits);         // LSB
    buf[6] = (uint8_t)(status_bits >> 8);    // MSB

    uint32_to_bcd(cashable_exp_days,   &buf[7], 2);
    uint32_to_bcd(restricted_exp_days, &buf[9], 2);

    crc16_append(buf, 11);
    return 13;
}

SasValidationStatusResponse sas_parse_validation_status(const uint8_t* buf, size_t len) {
    SasValidationStatusResponse resp = {0, 0, false};
    if (len < 15) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_EXT_VALIDATION_STATUS) return resp;

    // Asset number: "4 binary", LSB-first (Section 2.2.3).
    resp.asset_number = (uint32_t)buf[3] | ((uint32_t)buf[4] << 8)
                       | ((uint32_t)buf[5] << 16) | ((uint32_t)buf[6] << 24);
    resp.status_bits  = (uint16_t)buf[7] | ((uint16_t)buf[8] << 8);
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
    // Per SAS 6.02 Table 7.15: addr, cmd, length (= 3 + serial chars,
    // NOT a separate serial-length byte), 3-byte version, N-byte serial
    // (N = length-3), 2-byte CRC. Minimum frame (N=0): 8 bytes.
    if (len < 8) return resp;
    if (!crc16_verify(buf, len)) return resp;
    if (buf[1] != SAS_CMD_SEND_VERSION_SERIAL) return resp;

    memcpy(resp.sas_version, &buf[3], 3);
    resp.sas_version[3] = '\0';

    uint8_t total_len = buf[2];  // 3 (version) + N (serial)
    size_t serial_len = (total_len > 3) ? (size_t)(total_len - 3) : 0;
    if (serial_len > 40) serial_len = 40;
    size_t serial_end = len - 2;  // strip CRC
    if (6 + serial_len > serial_end) {
        serial_len = (serial_end > 6) ? (serial_end - 6) : 0;
    }
    memcpy(resp.serial_number, &buf[6], serial_len);
    resp.serial_number[serial_len] = '\0';

    resp.valid = true;
    return resp;
}
