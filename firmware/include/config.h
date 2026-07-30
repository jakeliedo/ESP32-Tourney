#pragma once
// =============================================================
// config.h – Central configuration for ESP32 GMI Module
// Target board: Waveshare ESP32-S3-ETH (ESP32-S3R8 + onboard W5500)
// All hardware pins, network parameters and SAS settings here.
// =============================================================

// ──────────────────────────────────────────────────────────────
// MACHINE IDENTITY — the ONE value to change per module before
// flashing. SAS address, MQTT client ID and all MQTT topics are
// derived from this single number (range 1–127 per SAS spec).
// ──────────────────────────────────────────────────────────────
#define MACHINE_NUMBER  1

#define STRINGIFY(x) #x
#define TOSTRING(x)  STRINGIFY(x)

// ──────────────────────────────────────────────────────────────
// W5500 SPI pin mapping – Waveshare ESP32-S3-ETH (onboard W5500)
// ──────────────────────────────────────────────────────────────
#define ETH_MOSI_PIN  11
#define ETH_MISO_PIN  12
#define ETH_SCLK_PIN  13
#define ETH_CS_PIN    14
#define ETH_RST_PIN    9   // set to -1 to disable hardware reset
#define ETH_INT_PIN   10   // interrupt-driven reception (INPUT only)
#define ETH_SPI_FREQ  8000000  // 8 MHz – reduce to 4M if signal noise

// ──────────────────────────────────────────────────────────────
// RS232 / SAS UART  (via MAX3232 + Optocoupler)
// ──────────────────────────────────────────────────────────────
#define SAS_UART_NUM    UART_NUM_2
#define SAS_UART_BAUD   19200     // SAS standard baud rate
// GPIO16/17 confirmed free (plain GPIO, not SD/ETH/strapping) on the
// official Waveshare ESP32-S3-ETH pinout diagram.
#define SAS_UART_TX_PIN 17
#define SAS_UART_RX_PIN 16
#define SAS_UART_BUF    512

// Polling cycle must not exceed 40 ms (SAS 6.0x requirement)
#define SAS_POLL_INTERVAL_MS  40
// Max retries before marking machine offline
#define SAS_MAX_RETRIES        3
// Timeout waiting for machine response (ms)
#define SAS_RESPONSE_TIMEOUT  20

// ──────────────────────────────────────────────────────────────
// SAS Machine Address — derived from MACHINE_NUMBER above
// ──────────────────────────────────────────────────────────────
#define SAS_MACHINE_ADDRESS  MACHINE_NUMBER

// ──────────────────────────────────────────────────────────────
// Network / MQTT
// ──────────────────────────────────────────────────────────────
#define MQTT_BROKER_HOST  "192.168.1.100"
#define MQTT_BROKER_PORT  1883
#define MQTT_CLIENT_ID    "GMI-Machine-" TOSTRING(MACHINE_NUMBER)
#define MQTT_USER         "esp32"
#define MQTT_PASS         "changeme"

// MQTT Topics — all derived from MACHINE_NUMBER, no duplicated literals
#define MQTT_TOPIC_TELEMETRY   "casino/machine/" TOSTRING(MACHINE_NUMBER) "/telemetry"
#define MQTT_TOPIC_EVENTS      "casino/machine/" TOSTRING(MACHINE_NUMBER) "/events"
#define MQTT_TOPIC_COMMANDS    "casino/machine/" TOSTRING(MACHINE_NUMBER) "/commands"
#define MQTT_TOPIC_STATUS      "casino/machine/" TOSTRING(MACHINE_NUMBER) "/status"

// ──────────────────────────────────────────────────────────────
// FreeRTOS Task Stack Sizes
// ──────────────────────────────────────────────────────────────
#define TASK_STACK_SAS      4096
#define TASK_STACK_NETWORK  8192
#define TASK_STACK_WATCHDOG 2048

// Watchdog timeout (ms) – triggers hard reset if SAS task freezes
#define WATCHDOG_TIMEOUT_MS  2000

// ──────────────────────────────────────────────────────────────
// NVS (Non-Volatile Storage) namespace
// ──────────────────────────────────────────────────────────────
#define NVS_NAMESPACE  "tourney"
#define NVS_KEY_TXN_ID "pending_txn_id"
#define NVS_KEY_TXN_AMT "pending_amt"
