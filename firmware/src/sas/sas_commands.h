#pragma once
// =============================================================
// sas_commands.h – SAS 6.0x Long Poll command builders & parsers
// All monetary values follow BCD (Binary Coded Decimal) encoding
// =============================================================
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

// ── SAS Command Codes ──────────────────────────────────────────
#define SAS_CMD_GENERAL_POLL        0x00  // 1-byte address poll
#define SAS_CMD_SHUTDOWN            0x01  // Long Poll 01: Shutdown (Lock Out Play) – Type S
#define SAS_CMD_STARTUP             0x02  // Long Poll 02: Startup (Enable Play) – Type S
#define SAS_CMD_ENABLE_BILL         0x06  // Long Poll 06: Enable Bill Acceptor – Type S
#define SAS_CMD_DISABLE_BILL        0x07  // Long Poll 07: Disable Bill Acceptor – Type S
#define SAS_CMD_SEND_CREDITS        0x1A  // Long Poll 1A: Current Credit Meter
#define SAS_CMD_SEND_HANDPAY        0x1B  // Long Poll 1B: Handpay Information
#define SAS_CMD_METERS_POLL         0xAF  // Long Poll AF: Extended Meters
#define SAS_CMD_METERS_POLL_6F      0x6F  // Long Poll 6F: Legacy Meters
#define SAS_CMD_SEND_VERSION_SERIAL 0x54  // Long Poll 54: Send SAS Version ID & Gaming Machine Serial Number
#define SAS_CMD_AFT_TRANSFER        0x72  // Long Poll 72: AFT Initiate/Query
#define SAS_CMD_AFT_REGISTER        0x73  // Long Poll 73: AFT Register Gaming Machine
#define SAS_CMD_AFT_LOCK_STATUS     0x74  // Long Poll 74: AFT Game Lock and Status Request
#define SAS_CMD_SEND_MACHINE_INFO   0x1F  // Long Poll 1F: Send Gaming Machine ID and Information (denom, max bet, paytable...)
#define SAS_CMD_EXT_VALIDATION_STATUS 0x7B  // Long Poll 7B: Extended Validation Status (printer/ticket cashout control)

// ── Extended Validation Status control/status bits (Table 15.2c) ────
// Sent as a 16-bit field: byte0 = LSB (bits 0-7 below), byte1 = MSB (only
// bit 7 of MSB, i.e. overall bit 15, is defined -- "cancel validation
// config"). Same LSB-first "binary" field convention as elsewhere (Section
// 2.2.3) -- see the byte-order lesson in project memory.
#define VALIDATION_BIT_PRINTER_CASHOUT       0x0001  // Use printer as cashout device (cashable AND restricted tickets)
#define VALIDATION_BIT_PRINTER_HANDPAY_RCPT  0x0002  // Print handpay receipt
#define VALIDATION_BIT_VALIDATE_HANDPAYS     0x0004  // Validate handpays/handpay receipts
#define VALIDATION_BIT_PRINT_RESTRICTED      0x0008  // Print restricted-amount cashout tickets
#define VALIDATION_BIT_FOREIGN_RESTRICTED    0x0010  // Print restricted tickets from "foreign" (non-ticket-in) sources
#define VALIDATION_BIT_TICKET_REDEMPTION     0x0020  // Accept/redeem tickets inserted by player (ticket-IN)
#define VALIDATION_BIT_CANCEL_CONFIG         0x8000  // MSB bit 7: cancel long-poll-4C validation ID config

// ── AFT Lock/Status Codes (byte 3 of LP 74 request) ──────────
#define AFT_LOCK_CODE_REQUEST       0x00  // Request lock
#define AFT_LOCK_CODE_CANCEL        0x80  // Cancel lock or pending lock request
#define AFT_LOCK_CODE_INTERROGATE   0xFF  // Interrogate current status only, no state change

// ── AFT Registration Codes (byte 4 of LP 73 request) ─────────
// Added 2026-09-05: LP 0x72 transfers were being rejected with status
// 0x93 "Asset number zero or does not match" even with the machine's
// own confirmed real asset number, in both byte orders -- turns out
// AFT requires registering first via LP 0x73 to obtain the Registration
// Key (20 bytes) the machine actually expects to see echoed back on
// every LP 0x72 transfer; sending an all-zero key (what this firmware
// did before) gets rejected regardless of the asset number.
// Per SAS 6.02 Section 8.1 (official spec text, not a third-party
// reference), registration is a TWO-poll handshake:
//   1. Send AFT_REG_CODE_INIT (0x00) with the machine's real asset number
//      and a zeroed key/POS ID -- this deletes any previously stored key
//      and moves the machine to registration status 0x00 ("ready").
//   2. Send AFT_REG_CODE_COMPLETE (0x01) with the SAME asset number and a
//      HOST-CHOSEN, NON-ZERO 20-byte registration key ("the final
//      registration key must be non-zero" -- spec text) -- only this
//      second poll actually moves the machine to status 0x01
//      ("registered"). The key is never issued BY the machine; the host
//      picks it and the machine just remembers it for later LP 0x72
//      validation.
// A prior version of this firmware sent only code 0x01 (skipping step 1)
// with an all-zero key, which got a "0x80 not registered" rejection --
// consistent with the spec's requirements, not evidence that 0x01 is the
// wrong code.
#define AFT_REG_CODE_INIT           0x00  // Step 1: initialize registration
#define AFT_REG_CODE_COMPLETE       0x01  // Step 2: complete registration (key must be non-zero)
#define AFT_REG_CODE_UNREGISTER     0x80  // Unregister
#define AFT_REG_CODE_QUERY          0xFF  // Query current registration only (no state change)

// ── AFT Registration Status Response Codes ───────────────────
#define AFT_REG_STATUS_READY         0x00  // Gaming machine registration ready
#define AFT_REG_STATUS_REGISTERED    0x01  // Gaming machine registered
#define AFT_REG_STATUS_PENDING       0x40  // Gaming machine registration pending
#define AFT_REG_STATUS_NOT_REGISTERED 0x80 // Gaming machine not registered

// ── AFT Transfer Types (Byte 6 of LP 72, Table 8.3d) ─────────
// This byte selects the transaction's real SAS purpose/direction, NOT
// which amount is cashable/restricted/nonrestricted -- a prior version
// of this firmware conflated the two, using 0x10/0x20 (real meaning:
// "bonus coin-out to machine" / "in-house to ticket") as if they meant
// "restricted"/"nonrestricted" transfer to the machine. That's why
// AFT_WITHDRAW sent 0x10 ("bonus win TO the machine") instead of a real
// machine-to-host withdrawal. The restriction category of the money is
// selected separately, by which AFT_AMOUNT_* field below carries the
// nonzero amount within a single 0x00/0x80-type request.
#define AFT_XFER_TO_MACHINE         0x00  // in-house, host -> gaming machine
#define AFT_XFER_BONUS_COINOUT      0x10  // bonus coin-out win, host -> gaming machine
#define AFT_XFER_BONUS_JACKPOT      0x11  // bonus jackpot win (forces attendant pay), host -> gaming machine
#define AFT_XFER_TO_TICKET          0x20  // in-house, host -> ticket
#define AFT_XFER_DEBIT_TO_MACHINE   0x40  // debit, host -> gaming machine
#define AFT_XFER_DEBIT_TO_TICKET    0x60  // debit, host -> ticket
#define AFT_XFER_FROM_MACHINE       0x80  // in-house, gaming machine -> host (withdraw/cash-out)
#define AFT_XFER_WIN_TO_HOST        0x90  // win amount (in-house), gaming machine -> host

// ── AFT Amount Category ───────────────────────────────────────
// Selects which of the 3 BCD amount fields in the LP 72 request carries
// amount_credits; the other two are sent as zero.
#define AFT_AMOUNT_CASHABLE         0  // regular cashable credits
#define AFT_AMOUNT_RESTRICTED       1  // restricted promotional (tournament) credits
#define AFT_AMOUNT_NONRESTRICTED    2  // nonrestricted promotional credits

// ── AFT Transfer Codes (Byte 4 of LP 72) ─────────────────────
#define AFT_CODE_TRANSFER_FULL      0x00  // Full transfer only
#define AFT_CODE_TRANSFER_PARTIAL   0x01  // Partial transfer allowed
#define AFT_CODE_CANCEL             0x80  // Cancel pending transfer
// Per SAS 6.02 Section 8.3 (spec text, confirmed 2026-09-08 after a real
// AFT_WITHDRAW got rejected 7 times in a row with status 0xC0 "not
// compatible with current transfer in progress"): 0xFE and 0xFF are BOTH
// "interrogate", but only 0xFF acknowledges completion and closes the
// transfer cycle. "Transfer code FE is identical to FF, except a response
// to an FE interrogation does not in any way affect the current transfer
// cycle" (spec text). Once an initiating LP 0x72 gets status 0x40
// (pending), "the host may not send another initiating long poll 72 until
// ... the host has received and acknowledged the final transfer and
// receipt status codes using the interrogation long poll 72 with transfer
// code FF" -- any other LP 0x72 sent in the meantime (including a new
// AFT_WITHDRAW) gets rejected with status C0, regardless of asset number,
// registration, or amount. This is exactly what was happening: the
// earlier $1 buy-in returned pending (0x40) and this firmware never
// followed up with an FF interrogation, so the machine kept the cycle
// open (probably already resolved to SUCCESS internally) and rejected
// every subsequent transfer with C0 until acknowledged.
#define AFT_CODE_INTERROGATE        0xFE  // "Peek" current/most-recent status -- no side effect, safe to poll repeatedly, does NOT close a pending transfer cycle
#define AFT_CODE_INTERROGATE_ACK    0xFF  // Interrogate AND acknowledge completion -- REQUIRED to close a transfer cycle after status 0x40, or all future LP 0x72 are rejected with 0xC0

// ── AFT Status Response Codes ────────────────────────────────
// Corrected 2026-09-05 against the real SAS 6.02 status table (cross-
// checked via SASPyTourney/saspy's AftTransferStatus.py, which is
// consistent across 3 independent AFT call sites in that library).
// The previous version of this table had several codes wrong/mislabeled
// (e.g. 0x9F was called "MACHINE_BUSY" -- it's actually a generic
// "Unexpected error", almost always caused by a malformed request frame
// rather than the machine being busy) and was missing most real codes.
#define AFT_STATUS_SUCCESS          0x00  // Full transfer successful
#define AFT_STATUS_PARTIAL          0x01  // Partial transfer successful (010xxxxx = pending)
#define AFT_STATUS_PENDING          0x40  // Transfer pending (not complete)
#define AFT_STATUS_CANCELLED        0x80  // Transfer cancelled by host
#define AFT_STATUS_TXN_ID_DUP       0x81  // Transaction ID not unique (same as last logged transfer)
#define AFT_STATUS_NOT_VALID        0x82  // Not a valid transfer function (bad type/amount/index)
#define AFT_STATUS_BAD_AMOUNT       0x83  // Not a valid transfer amount or expiration (non-BCD, etc.)
#define AFT_STATUS_OVER_LIMIT       0x84  // Transfer amount exceeds the gaming machine's transfer limit
#define AFT_STATUS_BAD_DENOM        0x85  // Transfer amount not an even multiple of machine denomination
#define AFT_STATUS_NO_PARTIAL       0x86  // Gaming machine unable to perform partial transfers to host
#define AFT_STATUS_BUSY             0x87  // Unable to perform transfers now (door open/tilt/disabled/cashout in progress)
#define AFT_STATUS_NOT_REGISTERED   0x88  // Gaming machine not registered (required for debit transfers)
#define AFT_STATUS_BAD_REG_KEY      0x89  // Registration key does not match
#define AFT_STATUS_NO_POS_ID        0x8A  // No POS ID (required for debit transfers)
#define AFT_STATUS_NO_WON_CREDITS   0x8B  // No won credits available for cashout
#define AFT_STATUS_NO_DENOM         0x8C  // No gaming machine denomination set
#define AFT_STATUS_EXPIRED          0x8D  // Expiration not valid for transfer to ticket (already expired)
#define AFT_STATUS_NO_TICKET_DEV    0x8E  // Transfer to ticket device not available
#define AFT_STATUS_POOL_MISMATCH    0x8F  // Existing restricted amounts from a different pool
#define AFT_STATUS_NO_RECEIPT_DEV   0x90  // Unable to print receipt (device not available)
#define AFT_STATUS_RECEIPT_DATA     0x91  // Insufficient data to print receipt (required fields missing)
#define AFT_STATUS_RECEIPT_NA       0x92  // Receipt not allowed for the specified transfer type
#define AFT_STATUS_BAD_ASSET        0x93  // Asset number zero or does not match
#define AFT_STATUS_NOT_LOCKED       0x94  // Gaming machine not locked (transfer required a lock)
#define AFT_STATUS_BAD_TXN_ID       0x95  // Transaction ID not valid
#define AFT_STATUS_UNEXPECTED_ERR   0x9F  // Unexpected error (110xxxxx = incompatible/unsupported poll) -- usually a malformed request frame, NOT "machine busy"
#define AFT_STATUS_TRANSFER_BUSY    0xC0  // Not compatible with current transfer in progress
#define AFT_STATUS_BAD_TRANSFER_CD  0xC1  // Unsupported transfer code
#define AFT_STATUS_NO_INFO          0xFF  // No transfer information available

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
    uint8_t  status_code;         // AFT_STATUS_* codes above
    uint8_t  transfer_buffer_pos; // Transaction buffer position (informational)
    uint8_t  receipt_status;
    uint8_t  transfer_type;       // Echoed AFT_XFER_* the machine actually applied
    uint32_t cashable_amount;
    uint32_t restricted_amount;
    uint32_t nonrestricted_amount;
    uint32_t transfer_amount;     // = cashable+restricted+nonrestricted, for callers that don't care which bucket
    char     transaction_id[21];  // ASCII, null-terminated
    bool     valid;
} SasAftResponse;

typedef struct {
    uint8_t  status_code;             // AFT_REG_STATUS_* codes above
    uint32_t asset_number;             // The machine's real asset number (authoritative -- use this, not a guess)
    uint8_t  registration_key[20];     // Must be echoed back on every subsequent LP 0x72
    bool     valid;
} SasAftRegisterResponse;

// Added 2026-09-08: a real EGT machine rejected AFT_WITHDRAW's standard
// "set amount to 9999999999, transfer code = partial allowed" method
// (spec Section 8.4) with status 0x86 "unable to perform partial
// transfers to the host" -- spec explicitly allows this: "Due to
// jurisdictional or other considerations, some gaming machines may
// refuse to perform partial transfers even if the host specifies
// partial transfer allowed" (Section 8.3). LP 0x74 reports the machine's
// current cashable amount ALREADY in cents (Table 8.2b) -- querying it
// first and then requesting a FULL transfer (code 0x00) for that EXACT
// amount avoids ever needing partial-transfer support at all.
typedef struct {
    uint32_t asset_number;
    uint8_t  game_lock_status;        // 0x00=locked, 0x40=lock pending, 0xFF=not locked
    uint8_t  available_transfers;     // bit1 = "transfer from gaming machine OK"
    uint8_t  host_cashout_status;     // bit1 = "transfer to host of less than full available amount allowed" (i.e. partial support)
    uint8_t  aft_status;              // bit3 = AFT registered, bit7 = any AFT enabled
    uint32_t current_cashable_amount;    // In CENTS already (not accounting-denom units) -- Table 8.2b
    uint32_t current_restricted_amount;  // In CENTS already
    uint32_t current_nonrestricted_amount; // In CENTS already
    bool     valid;
} SasAftLockStatusResponse;

// Added 2026-09-08 per explicit requirement: while this EVO bridge is the
// active host, ticket printing/cashout must be disallowed on the machine
// (the bridge is meant to be the sole cashout path, via AFT -- a player
// printing/redeeming a physical ticket would bypass tournament tracking
// entirely). LP 0x7B, Extended Validation Status, is the real SAS
// mechanism for this (Section 15.2 / Table 15.2c) -- NOT something we
// invented; it exists specifically so a host can allow/disallow the
// printer as a cashout device.
typedef struct {
    uint32_t asset_number;
    uint16_t status_bits;   // Current state of ALL bits after processing (Table 15.2c)
    bool     valid;
} SasValidationStatusResponse;

// Added 2026-09-05: a stable, physical-cabinet identifier (unlike our own
// NVS-assigned machine_id, which only controls leaderboard position/MQTT
// topic and says nothing about which real cabinet is actually wired to
// this board). Meant to be read once and cross-checked by the backend
// against an expected serial for this machine_id, to catch a board wired
// to the wrong physical machine immediately after connecting to the
// switch, rather than silently misattributing credits/leaderboard score.
typedef struct {
    char     sas_version[4];      // e.g. "602" for SAS 6.02, null-terminated
    char     serial_number[41];   // ASCII, null-terminated (spec allows up to 40 chars)
    bool     valid;
} SasVersionSerialResponse;

// Added 2026-09-08: the accounting denomination (SAS 6.02 Section 16 /
// Table C-4) is the unit every plain "credits" value on this machine is
// expressed in -- "the term 'credits', when used without qualifiers,
// generally refers to the accounting denomination" (spec text). This
// project's own convention (CLAUDE.md: "Credits: integer, 10000 =
// $100.00") silently assumed every machine uses a 1-cent denomination;
// that happened to match the one real machine tested so far (denom code
// 0x01), but is wrong in general -- a $1.00-denom machine (code 0x06)
// reporting a credit meter of "100" means $100.00, not $1.00. Query this
// once via LP 0x1F and use sas_denom_code_to_value_x10000() to convert
// any raw SAS credit value into real cents before it leaves this board.
typedef struct {
    uint8_t  denom_code;           // Raw code from Table C-4 (0x00-0x1F defined, rest reserved)
    uint32_t denom_value_x10000;   // Denomination value in ten-thousandths of a dollar (e.g. $1.00 -> 10000); 0 if code unknown/reserved
    bool     valid;
} SasMachineInfoResponse;

// ─────────────────────────────────────────────────────────────
// Frame builder functions – write into caller-provided buffer
// Caller must ensure buffer is large enough (max 32 bytes)
// Each builder returns total frame length including 2 CRC bytes
// ─────────────────────────────────────────────────────────────

// General Poll is built and sent directly in sas_polling.cpp
// (sas_general_poll()) -- unlike Long Polls it uses a completely
// different UART framing (no parity, 2 stop bits) confirmed against
// SASPyTourney/saspy on real hardware, so there's no shared byte
// layout worth factoring out here.

/**
 * Build a Type-S Long Poll (short command, no data payload).
 * Used for: Shutdown(0x01), Startup(0x02), EnableBill(0x06), DisableBill(0x07).
 * Machine responds with a single ACK byte (== address) or NACK (address | 0x80).
 * @param buf     Output buffer (min 4 bytes)
 * @param address SAS machine address
 * @param cmd     SAS_CMD_SHUTDOWN / STARTUP / ENABLE_BILL / DISABLE_BILL
 * @return frame length (always 4)
 */
size_t sas_build_lp_simple(uint8_t* buf, uint8_t address, uint8_t cmd);

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
 * Build Long Poll 72 – AFT Transfer Funds request.
 *
 * Full field layout per SAS 6.02 (verified 2026-09-05 against
 * SASPyTourney/saspy's aft_transfer_funds()/aft_in(), cross-checked
 * against 3 independent AFT call sites in that library for consistency
 * -- the previous version of this builder only sent 6 of the ~14
 * required fields, which is why a real machine returned "0x9F
 * Unexpected error" instead of a real transfer status):
 *   [addr][0x72][len]
 *   [transfer_code][txn_index=0][transfer_type]
 *   [cashable_amount:5 BCD][restricted_amount:5 BCD][nonrestricted_amount:5 BCD]
 *   [transfer_flags=0][asset_number:4][registration_key:20=0]
 *   [txn_id_len][txn_id: 0-20 ASCII]
 *   [expiration:4 BCD=0][pool_id:2=0][receipt_data_len=0]
 *   [lock_timeout:2=0]
 *   [CRC_L][CRC_H]
 * amount_credits is placed into whichever of the 3 amount fields matches
 * amount_category (AFT_AMOUNT_CASHABLE/RESTRICTED/NONRESTRICTED); the
 * other two are zero. transfer_type (AFT_XFER_*) is independent -- it
 * selects the transaction's real SAS purpose/direction (Table 8.3d), not
 * the restriction category of the money. Expiration/pool id/receipt are zero-filled --
 * this firmware doesn't do ticket transfers or request receipts, but
 * the fields must still be present and correctly sized for the frame to
 * parse on the machine's side.
 *
 * asset_number/registration_key must be the values obtained from a
 * prior successful LP 0x73 registration (sas_build_lp_aft_register() /
 * sas_parse_aft_register()) -- sending a guessed asset number with an
 * all-zero key gets rejected with AFT_STATUS_BAD_ASSET regardless of
 * whether the asset number itself is correct (confirmed 2026-09-05).
 * @param buf              Output buffer (min 96 bytes: ~76 max payload + 2 CRC + margin)
 * @param address          SAS machine address
 * @param transfer_code    AFT_CODE_* constant
 * @param transfer_type    AFT_XFER_* constant (real SAS purpose/direction)
 * @param amount_category  AFT_AMOUNT_* constant (which BCD field gets amount_credits)
 * @param amount_credits   Amount in credits (will be BCD-encoded, 5 bytes)
 * @param txn_id           Unique transaction ID string (max 20 chars)
 * @param asset_number     From a successful LP 0x73 registration
 * @param registration_key 20 bytes, from a successful LP 0x73 registration
 * @return frame length
 */
size_t sas_build_lp_aft(uint8_t* buf, uint8_t address,
                         uint8_t transfer_code, uint8_t transfer_type,
                         uint8_t amount_category, uint32_t amount_credits,
                         const char* txn_id,
                         uint32_t asset_number, const uint8_t* registration_key);

/**
 * Build Long Poll 73 – AFT Register Gaming Machine.
 *
 * Request: [addr][0x73][len]
 *   [reg_code]
 *   (only when reg_code != AFT_REG_CODE_QUERY:)
 *   [asset_number:4][registration_key:20][pos_id:4]
 *   [CRC_L][CRC_H]
 * len = 1 for a bare query (reg_code only), or 29 (0x1D) for an actual
 * register/unregister with the fields above. For a fresh registration,
 * pass asset_number=0 and a zeroed registration_key to request the
 * machine assign new ones; it may also accept/confirm a proposed
 * non-zero asset_number if you already know it.
 * @param buf              Output buffer (min 36 bytes)
 * @param address          SAS machine address
 * @param reg_code         AFT_REG_CODE_* constant
 * @param asset_number     Proposed asset number (0 = let the machine assign/confirm one)
 * @param registration_key 20 bytes (all-zero to request a new key); ignored if reg_code==QUERY
 * @param pos_id           4-byte POS identifier (0 if unused)
 * @return frame length
 */
size_t sas_build_lp_aft_register(uint8_t* buf, uint8_t address, uint8_t reg_code,
                                  uint32_t asset_number, const uint8_t* registration_key,
                                  uint32_t pos_id);

/**
 * Build Long Poll 74 – AFT Game Lock and Status Request.
 * Request: [addr][0x74][lock_code][transfer_condition][lock_timeout:2 BCD][CRC_L][CRC_H]
 * For a bare status interrogation (lock_code = AFT_LOCK_CODE_INTERROGATE),
 * transfer_condition and lock_timeout are ignored by the machine -- pass 0.
 * @param buf     Output buffer (min 8 bytes)
 * @param address SAS machine address
 * @param lock_code AFT_LOCK_CODE_* constant
 * @param transfer_condition Bitmask (Table 8.2a); ignored if lock_code==INTERROGATE
 * @param lock_timeout Lock expiration in hundredths of a second; ignored if lock_code==INTERROGATE
 * @return frame length (always 8)
 */
size_t sas_build_lp_aft_lock_status(uint8_t* buf, uint8_t address, uint8_t lock_code,
                                     uint8_t transfer_condition, uint16_t lock_timeout);

/**
 * Build Long Poll 7B – Extended Validation Status.
 * Request: [addr][0x7B][len=0x08][control_mask:2][status_bits:2]
 *          [cashable_exp_days:2 BCD][restricted_exp_days:2 BCD][CRC_L][CRC_H]
 * control_mask selects WHICH bits this call actually changes (1=control,
 * 0=leave alone) -- only bits set in control_mask are applied from
 * status_bits; every other bit (including reserved ones) is left as the
 * machine currently has it. Pass address=0 to broadcast to all machines on
 * the loop (type G) -- the machine then applies the setting but does not
 * respond.
 * @param buf                  Output buffer (min 13 bytes)
 * @param address              SAS machine address, or 0 for global broadcast
 * @param control_mask         VALIDATION_BIT_* bits to control (bitwise OR)
 * @param status_bits          VALIDATION_BIT_* bits to set to 1 (only meaningful where control_mask has a 1)
 * @param cashable_exp_days    0000=don't change, 9999=never expire
 * @param restricted_exp_days  0000=don't change, 9999=never expire
 * @return frame length (always 13)
 */
size_t sas_build_lp_validation_status(uint8_t* buf, uint8_t address,
                                       uint16_t control_mask, uint16_t status_bits,
                                       uint16_t cashable_exp_days, uint16_t restricted_exp_days);

/**
 * Build Long Poll 54 – Send SAS Version ID and Gaming Machine Serial Number.
 * Request: [addr][0x54][CRC_L][CRC_H] -- no data payload.
 * @param buf     Output buffer (min 4 bytes)
 * @param address SAS machine address
 * @return frame length (always 4)
 */
size_t sas_build_lp_version_serial(uint8_t* buf, uint8_t address);

/**
 * Build Long Poll 1F – Send Gaming Machine ID and Information.
 * Request: [addr][0x1F][CRC_L][CRC_H] -- no data payload.
 * @param buf     Output buffer (min 4 bytes)
 * @param address SAS machine address
 * @return frame length (always 4)
 */
size_t sas_build_lp_machine_info(uint8_t* buf, uint8_t address);

// ─────────────────────────────────────────────────────────────
// Response parser functions
// ─────────────────────────────────────────────────────────────

SasCreditResponse       sas_parse_credits(const uint8_t* buf, size_t len);
SasHandpayResponse      sas_parse_handpay(const uint8_t* buf, size_t len);
SasMetersResponse       sas_parse_meters(const uint8_t* buf, size_t len);
SasAftResponse          sas_parse_aft(const uint8_t* buf, size_t len);
SasAftRegisterResponse  sas_parse_aft_register(const uint8_t* buf, size_t len);
SasAftLockStatusResponse sas_parse_aft_lock_status(const uint8_t* buf, size_t len);
SasValidationStatusResponse sas_parse_validation_status(const uint8_t* buf, size_t len);
SasVersionSerialResponse sas_parse_version_serial(const uint8_t* buf, size_t len);
SasMachineInfoResponse  sas_parse_machine_info(const uint8_t* buf, size_t len);

/**
 * Convert a Table C-4 denomination code into a value in ten-thousandths
 * of a dollar (dollars * 10000), e.g. 0x01 (1 cent) -> 100, 0x06 ($1.00)
 * -> 10000. Returns 0 for code 0x00 ("none"/not set) or any code beyond
 * the defined 0x00-0x1F range (reserved) -- callers should treat 0 as
 * "unknown, do not use for conversion" rather than a real zero denom.
 */
uint32_t sas_denom_code_to_value_x10000(uint8_t denom_code);

// BCD helpers (used internally and available to callers)
uint32_t bcd_to_uint32(const uint8_t* bcd, size_t nibbles);
void     uint32_to_bcd(uint32_t value, uint8_t* bcd, size_t bytes);
