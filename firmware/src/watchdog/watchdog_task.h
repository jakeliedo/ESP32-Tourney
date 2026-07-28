#pragma once
// =============================================================
// watchdog_task.h – Watchdog Task interface
// =============================================================

/**
 * Start the watchdog FreeRTOS task.
 * Call from main.cpp after SAS task is created.
 */
void watchdog_task_start();

/**
 * Feed the watchdog from the SAS polling loop.
 * Must be called at least once per WATCHDOG_TIMEOUT_MS (2000ms).
 */
void watchdog_feed();
