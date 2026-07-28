// =============================================================
// watchdog_task.cpp – Watchdog & Security Task (any core, low priority)
//
// Monitors SAS task heartbeat.
// Resets ESP32 if SAS task stops feeding heartbeat for 2 seconds.
// =============================================================
#include "watchdog_task.h"
#include "../../include/config.h"

#include <Arduino.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_task_wdt.h>

static const char* TAG = "WATCHDOG";

static volatile TickType_t s_last_heartbeat = 0;

void watchdog_feed() {
    s_last_heartbeat = xTaskGetTickCount();
}

static void watchdog_task(void* pvParameters) {
    ESP_LOGI(TAG, "Watchdog Task started");
    s_last_heartbeat = xTaskGetTickCount();

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(500));

        TickType_t now  = xTaskGetTickCount();
        TickType_t diff = (now - s_last_heartbeat) * portTICK_PERIOD_MS;

        if (diff > WATCHDOG_TIMEOUT_MS) {
            ESP_LOGE(TAG, "SAS task heartbeat timeout (%lu ms) – HARD RESET",
                     (unsigned long)diff);
            esp_restart();
        }
    }
}

void watchdog_task_start() {
    xTaskCreate(
        watchdog_task,
        "WATCHDOG",
        TASK_STACK_WATCHDOG,
        NULL,
        1,      // Lowest priority
        NULL
    );
}
