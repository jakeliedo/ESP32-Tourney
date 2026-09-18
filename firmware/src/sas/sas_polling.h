#pragma once
// =============================================================
// sas_polling.h – SAS FreeRTOS Task (Core 1, highest priority)
// Manages 40ms polling cycle, 9-bit UART emulation, state machine
// =============================================================
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include "sas_commands.h"

// ── Slot Machine State Machine ────────────────────────────────
typedef enum {
    SLOT_STATE_INIT,              // 0 – Initializing, probing address
    SLOT_STATE_IDLE,              // 1 – Machine idle, no player
    SLOT_STATE_PLAYING,           // 2 – Player actively spinning
    SLOT_STATE_TOURNAMENT_LOCKED, // 3 – Tournament mode active, cashout disabled
    SLOT_STATE_HANDPAY,           // 4 – Jackpot handpay pending
    SLOT_STATE_OFFLINE,           // 5 – Link Down – no SAS response
    SLOT_STATE_DISABLED,          // 6 – Admin-disabled: play, bill, printer all off (LP 0x01 + 0x07)
} SlotState;

// ── Incoming command from server (via MQTT → Command_Queue) ──
typedef struct {
    uint8_t  cmd_type;       // 0=AFT_PUMP, 1=AFT_WITHDRAW, 2=LOCK, 3=UNLOCK
    uint32_t amount;         // Credits to transfer (0 if not applicable)
    char     txn_id[21];     // Transaction ID from server
} ServerCommand;

// ── Outgoing event to server (via Report_Queue → MQTT) ───────
typedef struct {
    uint8_t  exception_code; // SAS exception byte
    uint32_t credits;        // Current credit meter snapshot
    uint32_t coin_in;
    uint32_t coin_out;
    SlotState state;
    char     txn_id[21];     // Set when reporting AFT completion
    uint8_t  aft_status;     // Set when reporting AFT result
    bool     bv_enabled;     // Bill validator state, ack'd by the machine (LP 0x06/0x07)
    bool     printer_enabled; // Ticket cashout/redemption lockdown state (LP 0x7B)
    // Added 2026-09-17 (machine-diagnostics feature) -- see
    // sas_features_known() etc. below for the "not yet queried" semantics
    // these values follow (0/false doesn't mean "confirmed off", it can
    // mean "not yet known" -- the backend should treat these as
    // best-effort snapshot, not a guarantee, until the *_known() getter
    // has gone true at least once).
    uint32_t enabled_features;      // SAS_FEATURE_* bitmask (LP 0xA0), 0 if not yet known
    uint32_t cash_out_limit_cents;  // LP 0xA4, converted to cents, 0 if not yet known -- HOPPER coin-out limit only (Table 7.16a/b), NOT a ticket or AFT limit
    // Added 2026-09-18: LP 0x74's "gaming machine transfer limit" (Table
    // 8.2b) -- the actual queryable "will an AFT payout of this size get
    // rejected and need a handpay instead" figure (rejection = status
    // AFT_STATUS_OVER_LIMIT / 0x84). Distinct from cash_out_limit_cents
    // above (hopper-only) and from a machine's jurisdictional handpay/
    // jackpot win threshold (Section 14 of SAS 6.02), which the spec
    // documents as attendant-configured on the cabinet with NO
    // corresponding Long Poll to read it back -- not obtainable via SAS.
    uint32_t aft_transfer_limit_cents; // LP 0x74, in cents, 0 if not yet known
    bool     rte_guard_ok;          // Last LP 0x0E disable-RTE attempt ACK'd?
    bool     bill_config_ok;        // Last LP 0x08 persistent-enable write ACK'd?
    // Added 2026-09-18: persistent "is the slot door open right now" state
    // (SAS_EXC_SLOT_DOOR_OPENED/CLOSED, 0x11/0x12), mirrored from the same
    // flag that already freezes jackpot wager-inference while the door is
    // open. Distinct from exception_code above, which only reflects the
    // last-reported exception AT THE MOMENT of a report_event() call (most
    // report_event() call sites hardcode SAS_EXC_NO_ACTIVITY regardless of
    // door state) -- so exception_code alone cannot answer "is it open
    // right now" once even one more telemetry event has gone out since.
    bool     door_open;
    uint16_t last_cycle_overrun_ms; // 0 = no overrun since last report; >0 = worst overrun since last report
    // Machine identity/config (2026-09-17) -- already queried once at boot
    // by query_machine_identity()/query_machine_denom()/AFT registration
    // for internal use, just not previously forwarded off-board. Added for
    // the single-machine "read everything at once" technical view
    // (frontend/diagnostics) -- see that app's CLAUDE.md-documented layout.
    char     serial_number[41];  // LP 0x54, ASCII, empty until sas_identity_known()
    char     sas_version[4];     // LP 0x54, e.g. "602", empty until known
    uint8_t  denom_code;          // LP 0x1F, Table C-4 code, 0 until sas_denom_known()
    uint32_t denom_value_x10000;  // LP 0x1F, dollars*10000, 0 until known
    uint32_t asset_number;        // LP 0x73 (query or registration), 0 until known
    bool     aft_registered;      // Has a successful 2-step AFT registration completed?
} MachineEvent;

// ── Server command types ──────────────────────────────────────
#define CMD_AFT_PUMP     0   // AFT host→machine cashable transfer (LP 0x72)
#define CMD_AFT_WITHDRAW 1   // AFT machine→host full withdrawal (LP 0x72)
#define CMD_LOCK         2   // Tournament lock: LP 0x01 Shutdown
#define CMD_UNLOCK       3   // Tournament unlock: LP 0x02 Startup
#define CMD_DISABLE      4   // Full admin disable: LP 0x01 + LP 0x07
#define CMD_ENABLE       5   // Full admin enable: LP 0x02 + LP 0x06
#define CMD_ENABLE_BV    6   // Bill validator only: LP 0x06 (no Shutdown/Startup)
#define CMD_DISABLE_BV   7   // Bill validator only: LP 0x07 (no Shutdown/Startup)
#define CMD_ENABLE_PRINTER  8  // Re-allow ticket cashout/redemption: LP 0x7B
#define CMD_DISABLE_PRINTER 9  // Lock down ticket cashout/redemption: LP 0x7B
#define CMD_REFRESH_DIAGNOSTICS 10  // Operator-triggered re-query of LP 0xA0/0xA4 + re-assert LP 0x0E off, without a reboot

// ── Shared queues (created in main.cpp, used by both tasks) ──
extern QueueHandle_t g_command_queue;  // Server → SAS Task
extern QueueHandle_t g_report_queue;   // SAS Task → Network Task

/**
 * Start the SAS Polling FreeRTOS task, pinned to Core 1.
 * Must be called after UART is initialised.
 */
void sas_polling_task_start();

/**
 * Entry point for SAS FreeRTOS task (do not call directly).
 */
void sas_polling_task(void* pvParameters);

/**
 * Get current slot machine state (thread-safe read).
 */
SlotState sas_get_state();

/**
 * Physical machine identity (SAS version + real serial number), queried
 * once via LP 0x54 near boot -- see sas_polling.cpp's query_machine_identity().
 * Added 2026-09-05 so the backend can verify a board is wired to the
 * physical machine it's supposed to be (this project's own machine_id is
 * just an NVS-assigned leaderboard/MQTT identity, not a real machine ID --
 * it can't catch a board plugged into the wrong cabinet by itself).
 * sas_identity_known() returns false until the query has succeeded once;
 * the getters return empty strings until then.
 */
bool        sas_identity_known();
const char* sas_get_serial_number();
const char* sas_get_sas_version();

/**
 * Real accounting denomination, queried once via LP 0x1F near boot (see
 * sas_polling.cpp's query_machine_denom()). sas_denom_known() returns
 * false until the query has succeeded; sas_get_denom_value_x10000()
 * returns 0 until then -- callers must not treat 0 as "1 cent", it means
 * "not yet known, don't convert". See SasMachineInfoResponse in
 * sas_commands.h for why this matters (credits are in denom units, not
 * always cents).
 */
bool     sas_denom_known();
uint8_t  sas_get_denom_code();
uint32_t sas_get_denom_value_x10000();

/**
 * Machine-diagnostics getters (LP 0xA0/0xA4/0x0E + LP 0x08 bookkeeping),
 * added 2026-09-17. Queried once at boot (3 retries) and re-checked every
 * ~5 minutes (an operator may change machine config via the audit menu
 * mid-session), plus on-demand via CMD_REFRESH_DIAGNOSTICS. The *_known()
 * getters return false until the first successful query -- callers must
 * not treat the paired value's default (0/false) as a confirmed reading.
 */
bool     sas_features_known();
uint32_t sas_get_enabled_features();
bool     sas_cash_out_limit_known();
uint32_t sas_get_cash_out_limit_cents();
bool     sas_aft_transfer_limit_known();   // LP 0x74 transfer-limit query succeeded at least once?
uint32_t sas_get_aft_transfer_limit_cents();
bool     sas_rte_guard_ok();    // last LP 0x0E disable-RTE attempt ACK'd? (false until first attempt)
bool     sas_bill_config_ok();  // last LP 0x08 persistent-enable write ACK'd? (false until first attempt)
