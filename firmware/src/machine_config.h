#pragma once
#include <stdint.h>
#include <ETH.h>

// Machine identity – loaded from NVS on boot, derived from provisioned ID.
// Access these after machine_config_init() returns.
extern uint8_t   g_machine_id;            // 1–99
extern IPAddress g_eth_static_ip;         // 192.168.100.(199+id)
extern char      g_mqtt_client_id[24];    // "GMI-Machine-01"
extern char      g_topic_telemetry[44];   // "casino/machine/01/telemetry"
extern char      g_topic_events[44];
extern char      g_topic_commands[44];
extern char      g_topic_status[44];

// Call once in setup() immediately after nvs_flash_init().
// If no ID is stored, enters interactive provisioning mode (blocks until SET_ID received).
void machine_config_init();
