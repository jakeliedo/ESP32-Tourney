// =============================================================
// machine_config.cpp – NVS-based machine identity
//
// First boot (no ID stored): enters provisioning mode on Serial.
//   Send "SET_ID <1-99>" to set machine number, board reboots.
// Subsequent boots: reads ID from NVS, derives IP/MQTT/SAS values.
// =============================================================
#include "machine_config.h"
#include "../include/config.h"

#include <nvs.h>
#include <esp_log.h>
#include <Arduino.h>

static const char* TAG = "MACHINE_CFG";

uint8_t   g_machine_id       = 0;
IPAddress g_eth_static_ip;
char      g_mqtt_client_id[24]  = {};
char      g_topic_telemetry[44] = {};
char      g_topic_events[44]    = {};
char      g_topic_commands[44]  = {};
char      g_topic_status[44]    = {};

// Derive all runtime config from a confirmed machine_id.
static void derive_config(uint8_t id) {
    g_machine_id    = id;
    g_eth_static_ip = IPAddress(192, 168, 100, (uint8_t)(199 + id));  // .200 … .254 for id 1-55

    snprintf(g_mqtt_client_id,   sizeof(g_mqtt_client_id),   "GMI-Machine-%02d", id);
    snprintf(g_topic_telemetry,  sizeof(g_topic_telemetry),  "casino/machine/%02d/telemetry", id);
    snprintf(g_topic_events,     sizeof(g_topic_events),     "casino/machine/%02d/events",    id);
    snprintf(g_topic_commands,   sizeof(g_topic_commands),   "casino/machine/%02d/commands",  id);
    snprintf(g_topic_status,     sizeof(g_topic_status),     "casino/machine/%02d/status",    id);
}

// Block on Serial waiting for "SET_ID <1-99>".
// Uses MAC as temporary MQTT client ID so the board is identifiable while unprovisioned.
static void provisioning_mode() {
    // Use eFuse MAC as unique board identifier during provisioning
    uint64_t chipid = ESP.getEfuseMac();

    Serial.println("\n============================================");
    Serial.println(" GMI EVO – PROVISIONING MODE");
    Serial.printf (" MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
                   (uint8_t)(chipid >> 40), (uint8_t)(chipid >> 32),
                   (uint8_t)(chipid >> 24), (uint8_t)(chipid >> 16),
                   (uint8_t)(chipid >> 8),  (uint8_t)(chipid));
    Serial.println(" No machine ID found in NVS.");
    Serial.println(" Command: SET_ID <1-99>   (e.g. SET_ID 02)");
    Serial.println("============================================\n");

    String line;
    while (true) {
        if (Serial.available()) {
            line = Serial.readStringUntil('\n');
            line.trim();

            if (line.startsWith("SET_ID ")) {
                int id = line.substring(7).toInt();
                if (id >= 1 && id <= 99) {
                    nvs_handle_t h;
                    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
                        nvs_set_u8(h, "machine_id", (uint8_t)id);
                        nvs_commit(h);
                        nvs_close(h);
                    }
                    Serial.printf("[OK] Machine ID %d saved. Rebooting...\n", id);
                    delay(200);
                    esp_restart();
                } else {
                    Serial.println("[ERR] ID must be 1-99.");
                }
            } else if (line.length() > 0) {
                Serial.printf("[ERR] Unknown command: \"%s\"\n", line.c_str());
                Serial.println("      Use: SET_ID <1-99>");
            }
        }
        delay(50);
    }
}

void machine_config_init() {
    uint8_t id = 0;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "machine_id", &id);
        nvs_close(h);
    }

    if (id == 0) {
        provisioning_mode();  // never returns – reboots after SET_ID
    }

    derive_config(id);

    ESP_LOGI(TAG, "Machine ID: %d | IP: 192.168.100.%d | Client: %s",
             g_machine_id, 199 + g_machine_id, g_mqtt_client_id);
}
