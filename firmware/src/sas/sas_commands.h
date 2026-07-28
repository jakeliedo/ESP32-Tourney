#pragma once
// =============================================================
// sas_commands.h – SAS 6.0x Long Poll command builders & parsers
// All monetary values follow BCD (Binary Coded Decimal) encoding
// =============================================================
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

// ── SAS Command Codes ──────────────────────────────────────────
#define SAS_CMD_GENERAL_POLL        0x00  // 2-byte address poll
#define SAS_CMD_SEND_CREDITS        0x1A  // Long Poll 1A: Current Credit Meter
#define SAS_CMD_SEND_HANDPAY        0x1B  // Long Poll 1B: Handpay Information
#define SAS_CMD_METERS_POLL         0xAF  // Long Poll AF: Extended Meters
#define SAS_CMD_METERS_POLL_6F      0x6F  // Long Poll 6F: Legacy Meters
#define SAS_CMD_AFT_TRANSFER        0x72  // Long Poll 72: AFT Initiate/Query

// ── AFT Transfer Types (Byte 6 of LP 72) ─────────────────────
#define AFT_TYPE_CASHABLE           0x00  // Cashable – player can cash out
#define AFT_TYPE_RESTRICTED         0x10  // Restricted promo – tournament credits
#define AFT_TYPE_NONRESTRICTED      0x20  // Non-restricted promotional

// ── AFT Transfer Codes (Byte 4 of LP 72) ─────────────────────
#define AFT_CODE_TRANSFER_FULL      0x00  // Full transfer only
#define AFT_CODE_TRANSFER_PARTIAL   0x01  // Partial transfer allowed
#define AFT_CODE_CANCEL             0x80  // Cancel pending transfer
#define AFT_CODE_INTERROGATE        0xFE  // Query last transaction status

// ── AFT Status Response Codes ────────────────────────────────
#define AFT_STATUS_SUCCESS          0x00
#define AFT_STATUS_PENDING          0x40
#define AFT_STATUS_TRANSFER_ZERO    0x41
#define AFT_STATUS_NOT_COMPATIBLE   0x80
#define AFT_STATUS_UNSUPPORTED      0x81
#define AFT_STATUS_NO_POS_ID        0x82
#define AFT_STATUS_NO_WAGER         0x84
#define AFT_STATUS_CASHOUT_ERROR    0x93
#define AFT_STATUS_SLOT_DISABLED    0x94
#define AFT_STATUS_INSUFFICIENT     0x95
#define AFT_STATUS_MACHINE_BUSY     0x9F

// ── SAS Exception Codes (General Poll responses) ─────────────
#define SAS_EXC_NO_ACTIVITY         0x00
#define SAS_EXC_SLOT_DOOR_OPENED    0x11
#define SAS_EXC_SLOT_DOOR_CLOSED    0x12
#define SAS_EXC_REEL_SPIN_BEGIN     0x27
#define SAS_EXC_CASHOUT_PRESSED     0x26
#define SAS_EXC_HANDPAY_PENDING     0x44
#define SAS_EXC_CASHOUT_TICKET      0x4C
#define SAS_EXC_AFT_TRANSFER_DONE   0x67

// ─────────────────────────────────────────────────────────────
// Parsed response structures
// ─────────────────────────────────────────────────────────────

typedef struct {
    uint32_t credits;       // Current credit meter value
    bool     valid;
} SasCreditResponse;

typedef struct {
    uint32_t handpay_amount; // Amount in credits (BCD decoded)
    uint8_t  type;           // 0=progressive, 1=cancel, 2=jackpot
    bool     valid;
} SasHandpayResponse;

typedef struct {
    uint32_t coin_in;
    uint32_t coin_out;
    uint32_t games_played;
    bool     valid;
} SasMetersResponse;

typedef struct {
    uint8_t  status_code;   // AFT_STATUS_* codes above
    uint32_t transfer_amount;
    char     transaction_id[21]; // ASCII, null-terminated
    bool     valid;
} SasAftResponse;

// ─────────────────────────────────────────────────────────────
// Frame builder functions – write into caller-provided buffer
// Caller must ensure buffer is large enough (max 32 bytes)
// Each builder returns total frame length including 2 CRC bytes
// ─────────────────────────────────────────────────────────────

/**
 * Build a 2-byte General Poll frame.
 * @param buf     Output buffer (min 2 bytes)
 * @param address SAS machine address (1–127)
 * @return frame length (always 2)
 */
size_t sas_build_general_poll(uint8_t* buf, uint8_t address);

/**
 * Build Long Poll 1A – Request Current Credit Meter.
 * @param buf     Output buffer (min 5 bytes)
 * @param address SAS machine address
 * @return frame length
 */
size_t sas_build_lp_credits(uint8_t* buf, uint8_t address);

/**
 * Build Long Poll 1B – Request Handpay Information.
 */
size_t sas_build_lp_handpay(uint8_t* buf, uint8_t address);

/**
 * Build Long Poll AF – Extended Meters Poll.
 */
size_t sas_build_lp_meters(uint8_t* buf, uint8_t address);

/**
 * Build Long Poll 72 – AFT Initiate Transfer.
 * @param buf            Output buffer (min 30 bytes)
 * @param address        SAS machine address
 * @param transfer_code  AFT_CODE_* constant
 * @param transfer_type  AFT_TYPE_* constant
 * @param amount_credits Amount in credits (will be BCD-encoded)
 * @param txn_id         Unique transaction ID string (max 20 chars)
 * @return frame length
 */
size_t sas_build_lp_aft(uint8_t* buf, uint8_t address,
                         uint8_t transfer_code, uint8_t transfer_type,
                         uint32_t amount_credits, const char* txn_id);

// ─────────────────────────────────────────────────────────────
// Response parser functions
// ─────────────────────────────────────────────────────────────

SasCreditResponse  sas_parse_credits(const uint8_t* buf, size_t len);
SasHandpayResponse sas_parse_handpay(const uint8_t* buf, size_t len);
SasMetersResponse  sas_parse_meters(const uint8_t* buf, size_t len);
SasAftResponse     sas_parse_aft(const uint8_t* buf, size_t len);

// BCD helpers (used internally and available to callers)
uint32_t bcd_to_uint32(const uint8_t* bcd, size_t nibbles);
void     uint32_to_bcd(uint32_t value, uint8_t* bcd, size_t bytes);
