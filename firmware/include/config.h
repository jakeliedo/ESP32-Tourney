#pragma once
// =============================================================
// config.h – Central configuration for ESP32 GMI Module
// All hardware pins, network parameters and SAS settings here.
// =============================================================

// ──────────────────────────────────────────────────────────────
// W5500 SPI (VSPI bus) pin mapping
// ──────────────────────────────────────────────────────────────
#define ETH_MOSI_PIN  23
#define ETH_MISO_PIN  19
#define ETH_SCLK_PIN  18
#define ETH_CS_PIN     5
#define ETH_RST_PIN   26   // set to -1 to disable hardware reset
#define ETH_INT_PIN   35   // interrupt-driven reception (INPUT only)
#define ETH_SPI_FREQ  8000000  // 8 MHz – reduce to 4M if signal noise

// ──────────────────────────────────────────────────────────────
// RS232 / SAS UART  (via MAX3232 + Optocoupler)
// ──────────────────────────────────────────────────────────────
#define SAS_UART_NUM    UART_NUM_2
#define SAS_UART_BAUD   19200     // SAS standard baud rate
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
// SAS Machine Address (1–127, set per physical machine)
// ──────────────────────────────────────────────────────────────
#define SAS_MACHINE_ADDRESS  0x01

// ──────────────────────────────────────────────────────────────
// Network / MQTT
// ──────────────────────────────────────────────────────────────
#define MQTT_BROKER_HOST  "192.168.1.100"
#define MQTT_BROKER_PORT  1883
#define MQTT_CLIENT_ID    "GMI-Machine-01"
#define MQTT_USER         "esp32"
#define MQTT_PASS         "changeme"

// MQTT Topics
#define MQTT_TOPIC_TELEMETRY   "casino/machine/01/telemetry"
#define MQTT_TOPIC_EVENTS      "casino/machine/01/events"
#define MQTT_TOPIC_COMMANDS    "casino/machine/01/commands"
#define MQTT_TOPIC_STATUS      "casino/machine/01/status"

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
