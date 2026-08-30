// =============================================================
// main.cpp – ESP32-C3 GMI Module Entry Point (ETH01-Evo)
//
// Boot sequence:
//  1. Initialise NVS flash
//  2. Configure UART for SAS (19200 baud, 8N1 base, parity toggled at runtime)
//  3. Initialise DM9051 Ethernet (ETH.h, lwIP, DHCP)
//  4. Initialise MQTT client
//  5. Start FreeRTOS tasks (single core – separated by priority, not core):
//     - SAS Polling Task  → Core 0, highest priority
//     - Network/MQTT Task → Core 0, medium priority
//     - Watchdog Task     → Core 0, lowest priority
// =============================================================
#include <Arduino.h>
#include <nvs_flash.h>
#include <driver/uart.h>
#include <esp_log.h>

#include "include/config.h"
#include "src/network/eth_manager.h"
#include "src/network/mqtt_client.h"
#include "src/sas/sas_polling.h"
#include "src/watchdog/watchdog_task.h"

static const char* TAG = "MAIN";

// ── UART2 initialisation for SAS ─────────────────────────────

static void uart_sas_init() {
    uart_config_t cfg = {
        .baud_rate           = SAS_UART_BAUD,
        .data_bits           = UART_DATA_8_BITS,
        .parity              = UART_PARITY_DISABLE,  // toggled per-byte in sas_polling
        .stop_bits           = UART_STOP_BITS_1,
        .flow_ctrl           = UART_HW_FLOWCTRL_DISABLE,
        .rx_flow_ctrl_thresh = 0,
        .source_clk          = UART_SCLK_DEFAULT,
    };

    ESP_ERROR_CHECK(uart_param_config(SAS_UART_NUM, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(SAS_UART_NUM,
                                  SAS_UART_TX_PIN,
                                  SAS_UART_RX_PIN,
                                  UART_PIN_NO_CHANGE,
                                  UART_PIN_NO_CHANGE));
    ESP_ERROR_CHECK(uart_driver_install(SAS_UART_NUM,
                                        SAS_UART_BUF * 2,
                                        SAS_UART_BUF * 2,
                                        0, NULL, 0));
    ESP_LOGI(TAG, "UART%d ready: %d baud TX=%d RX=%d",
             SAS_UART_NUM, SAS_UART_BAUD, SAS_UART_TX_PIN, SAS_UART_RX_PIN);
}

// ── Arduino setup() ──────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    ESP_LOGI(TAG, "ESP32 GMI Module booting...");

    // 1. NVS – required for transaction persistence and ETH.h
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES ||
        nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition damaged – erasing and re-initialising");
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    // 2. UART for SAS RS232 interface
    uart_sas_init();

    // 3. Ethernet (blocks until IP acquired or 10s timeout)
    if (!eth_manager_init()) {
        ESP_LOGW(TAG, "Ethernet not ready at boot – continuing anyway");
    }

    // 4. MQTT client configuration
    mqtt_client_init();

    // 5. Start FreeRTOS tasks (single core – priority-separated)
    sas_polling_task_start();   // Highest priority
    mqtt_task_start();           // Medium priority
    watchdog_task_start();       // Lowest priority

    ESP_LOGI(TAG, "All tasks started. IP: %s", eth_manager_get_ip().c_str());
}

// ── Arduino loop() – not used (all work done in RTOS tasks) ──

void loop() {
    // Feed watchdog from main loop as additional safety net
    watchdog_feed();
    vTaskDelay(pdMS_TO_TICKS(1000));
}
