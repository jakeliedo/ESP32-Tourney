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
} MachineEvent;

// ── Server command types ──────────────────────────────────────
#define CMD_AFT_PUMP     0   // AFT host→machine cashable transfer (LP 0x72)
#define CMD_AFT_WITHDRAW 1   // AFT machine→host full withdrawal (LP 0x72)
#define CMD_LOCK         2   // Tournament lock: LP 0x01 Shutdown
#define CMD_UNLOCK       3   // Tournament unlock: LP 0x02 Startup
#define CMD_DISABLE      4   // Full admin disable: LP 0x01 + LP 0x07
#define CMD_ENABLE       5   // Full admin enable: LP 0x02 + LP 0x06

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
