#pragma once
// =============================================================
// config.h – Central configuration for WAVGAT/WT32-ETH01-Evo
// Target MCU : ESP32-C3 (RISC-V single-core, 160 MHz)
// Ethernet   : DM9051NP onboard (SPI, internal traces – fixed)
// All hardware pins, network parameters and SAS settings here.
// =============================================================

// ──────────────────────────────────────────────────────────────
// DM9051 SPI pin mapping (onboard, ETH01-Evo)
// Confirmed by 3 independent sources with real-hardware testing:
// ESPresense #1467, ESPHome PR #6861, androegg.de shop page.
// Not on the exposed header – internal traces, DO NOT change.
// ──────────────────────────────────────────────────────────────
#define ETH_MOSI_PIN     10
#define ETH_MISO_PIN      3
#define ETH_SCLK_PIN      7
#define ETH_CS_PIN        9   // also the GPIO9 boot-strapping pin (CS idle-high = boot bit 1, consistent)
#define ETH_RST_PIN       6
#define ETH_INT_PIN       8
#define ETH_SPI_FREQ_MHZ  8   // MHz (not Hz!). Community-tested up to 20MHz OK, 26MHz+ causes read errors.

// ──────────────────────────────────────────────────────────────
// ESP32-C3 strapping pins – GPIO2, GPIO8, GPIO9 (official datasheet).
// GPIO8/GPIO9 are already claimed by DM9051 (INT/CS) above – fine,
// their required boot levels match the chip's idle SPI state.
// Avoid GPIO2 for anything else (vendor uses it for AT-mode TXD).
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// RS232 / SAS UART  (UART1, via MAX3232 + Optocoupler)
// GPIO18/GPIO19: confirmed "Universal IO" (no strapping, no
// multiplex function) on the official ETH01-Evo pin table.
// UART0 (GPIO1/GPIO3 on the debug header) stays for Serial/flashing.
// NOTE: ESP32-C3 only has UART0 and UART1 – no UART2.
// ──────────────────────────────────────────────────────────────
#define SAS_UART_NUM    UART_NUM_1
#define SAS_UART_BAUD   19200     // SAS standard baud rate
#define SAS_UART_TX_PIN 18
#define SAS_UART_RX_PIN 19
#define SAS_UART_BUF    512

// Polling cycle must not exceed 40 ms (SAS 6.0x requirement)
#define SAS_POLL_INTERVAL_MS  40
// Max retries before marking machine offline
#define SAS_MAX_RETRIES        3
// Timeout waiting for machine response (ms) -- used for General Poll and
// other short/frequent exchanges (every SAS_POLL_INTERVAL_MS cycle).
#define SAS_RESPONSE_TIMEOUT  20
// Longer timeout for infrequent, larger responses (Credits, Meters, AFT,
// Handpay) that need more bytes than a General Poll ack -- these only run
// once every several cycles, so there's slack in the SAS_POLL_INTERVAL_MS
// budget to wait longer without risking the 40ms hard requirement.
// Worst case per SAS 6.02 timing rules: 20ms response window (time to
// start responding) + up to 5ms per byte thereafter (max inter-byte gap).
// Meters (LP 0xAF) is the longest response we parse at 16 bytes:
// 20 + 15*5 = 95ms worst case -- 35ms was measured truncating every
// single Credits/Meters response on real hardware (confirmed via
// COM7 capture: 334/334 polls failed CRC, always cut off at n=3-4
// bytes). 100ms gives headroom above the 95ms worst case.
#define SAS_LONG_POLL_TIMEOUT  100

// ──────────────────────────────────────────────────────────────
// SAS Machine Address – derived at runtime from NVS machine_id.
// g_machine_id (uint8_t) is set by machine_config_init().
// ──────────────────────────────────────────────────────────────

// Fixed "wakeup" poll address, sent as a preamble byte before the real
// machine address on every SAS exchange. Confirmed against SASPyTourney
// (github.com/jakeliedo/SASpyTourney, using the community `saspy`
// library) as the real-hardware-verified value most EGMs expect --
// 0x00-0x01 alone (what this firmware used to send) let real machines
// echo/ignore the poll instead of reporting exceptions. Try 0x80 if
// 0x82 doesn't work on a given machine.
#define SAS_POLL_ADDRESS  0x82

// ──────────────────────────────────────────────────────────────
// Network / MQTT
// Per-machine values (IP, Client ID, topics) are derived at runtime
// by machine_config.cpp from the provisioned machine ID stored in NVS.
// IP formula: 192.168.100.(199 + machine_id)   e.g. ID=1 → .200
// ──────────────────────────────────────────────────────────────
#define ETH_STATIC_GW    192, 168, 100,   1
#define ETH_STATIC_MASK  255, 255, 254,   0

#define MQTT_BROKER_HOST  "192.168.100.69"
#define MQTT_BROKER_PORT  1883
#define MQTT_USER         "esp32"
#define MQTT_PASS         "changeme"
// Override PubSubClient default (15s). Mosquitto fires LWT after 1.5× this value.
// 5s keepalive → LWT in ~7.5s after hard disconnect.
#define MQTT_KEEPALIVE    5

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
