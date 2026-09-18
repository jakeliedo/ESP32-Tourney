// =============================================================
// mqtt_client.cpp – MQTT Network Task
//
// Responsibilities:
//  - Maintain persistent MQTT connection to broker
//  - Drain Report_Queue → serialize to JSON → publish
//  - Receive command JSON from server → parse → push to Command_Queue
//  - Reconnect automatically on disconnect
//
// NOTE: Runs on Core 0 at medium priority, sharing the single
// ESP32-C3 core with the higher-priority SAS Polling Task.
// =============================================================
#include "mqtt_client.h"
#include "eth_manager.h"
#include "../../include/config.h"
#include "../machine_config.h"
#include "../sas/sas_polling.h"
#include "../led_indicator.h"

#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <WiFiClient.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

static const char* TAG = "MQTT";

// PubSubClient uses a plain TCP client (Ethernet via lwIP)
static WiFiClient   s_net_client;
static PubSubClient s_mqtt(s_net_client);

// Set false on every (re)connect; publish_identity_if_known() flips it
// true once it has actually published (see below).
static bool s_identity_published = false;

// ── MQTT incoming message callback ────────────────────────────

static void on_message(char* topic, uint8_t* payload, unsigned int length) {
    led_pulse_network();  // real inbound MQTT traffic -- see led_indicator.h
    if (strcmp(topic, g_topic_commands) != 0) return;

    // Parse JSON command from server
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
        ESP_LOGW(TAG, "JSON parse error: %s", err.c_str());
        return;
    }

    ServerCommand cmd;
    memset(&cmd, 0, sizeof(cmd));

    const char* type = doc["type"] | "";
    if      (strcmp(type, "AFT_PUMP")     == 0) cmd.cmd_type = CMD_AFT_PUMP;
    else if (strcmp(type, "AFT_WITHDRAW") == 0) cmd.cmd_type = CMD_AFT_WITHDRAW;
    else if (strcmp(type, "LOCK")         == 0) cmd.cmd_type = CMD_LOCK;
    else if (strcmp(type, "UNLOCK")       == 0) cmd.cmd_type = CMD_UNLOCK;
    else if (strcmp(type, "DISABLE")      == 0) cmd.cmd_type = CMD_DISABLE;
    else if (strcmp(type, "ENABLE")       == 0) cmd.cmd_type = CMD_ENABLE;
    else if (strcmp(type, "ENABLE_BV")    == 0) cmd.cmd_type = CMD_ENABLE_BV;
    else if (strcmp(type, "DISABLE_BV")   == 0) cmd.cmd_type = CMD_DISABLE_BV;
    else if (strcmp(type, "ENABLE_PRINTER")  == 0) cmd.cmd_type = CMD_ENABLE_PRINTER;
    else if (strcmp(type, "DISABLE_PRINTER") == 0) cmd.cmd_type = CMD_DISABLE_PRINTER;
    else if (strcmp(type, "REFRESH_DIAGNOSTICS") == 0) cmd.cmd_type = CMD_REFRESH_DIAGNOSTICS;
    else {
        ESP_LOGW(TAG, "Unknown command type: %s", type);
        return;
    }

    cmd.amount = doc["amount"] | 0;
    const char* txn = doc["txn_id"] | "";
    strncpy(cmd.txn_id, txn, 20);

    if (xQueueSend(g_command_queue, &cmd, pdMS_TO_TICKS(10)) != pdTRUE) {
        ESP_LOGW(TAG, "Command queue full – dropping command");
    }
}

// ── MQTT reconnect with exponential back-off ──────────────────

static void mqtt_reconnect() {
    uint32_t delay_ms = 1000;
    while (!s_mqtt.connected()) {
        if (!eth_manager_is_connected()) {
            ESP_LOGW(TAG, "No Ethernet – waiting...");
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }
        ESP_LOGI(TAG, "Connecting to MQTT broker %s:%d ...",
                 MQTT_BROKER_HOST, MQTT_BROKER_PORT);

        if (s_mqtt.connect(g_mqtt_client_id, MQTT_USER, MQTT_PASS,
                           g_topic_status, 1, true, "offline")) {
            ESP_LOGI(TAG, "MQTT connected");
            s_mqtt.subscribe(g_topic_commands);
            s_mqtt.publish(g_topic_status, "online", true);
            s_identity_published = false;  // re-publish identity on every (re)connect
        } else {
            ESP_LOGW(TAG, "MQTT connect failed rc=%d, retry in %lums",
                     s_mqtt.state(), (unsigned long)delay_ms);
            vTaskDelay(pdMS_TO_TICKS(delay_ms));
            if (delay_ms < 30000) delay_ms *= 2;
        }
    }
}

// ── Physical machine identity (LP 0x54, published once) ───────
//
// Retained so the backend sees it immediately on subscribe, even if it
// connects after this board already published. Re-published on every
// reconnect (cheap, and covers a broker restart losing retained state).
// See sas_polling.h for why this is a separate identity from
// g_machine_id: it's the only thing that lets the backend confirm a
// board is actually wired to the physical machine it's supposed to be,
// right after connecting a whole bank of machines to the switch.

static void publish_identity_if_known() {
    if (s_identity_published || !sas_identity_known()) return;

    StaticJsonDocument<128> doc;
    doc["machine_id"]  = g_mqtt_client_id;
    doc["sas_version"] = sas_get_sas_version();
    doc["serial"]       = sas_get_serial_number();

    char buf[128];
    serializeJson(doc, buf, sizeof(buf));
    s_mqtt.publish(g_topic_identity, buf, true);  // retained
    s_identity_published = true;
}

// ── Report_Queue → JSON serialiser ────────────────────────────

static void serialize_and_publish(const MachineEvent* ev) {
    // 2026-09-18: bumped 512->640 (2 more fields: aft_transfer_limit_cents,
    // door_open) -- see the resp_buf[32] Meters-poll lesson (2026-09-17,
    // NHATKY.md) for why "add a couple fields, leave the buffer as-is" is
    // exactly the kind of change that silently overflows a just-barely-
    // fits buffer; keeping real headroom here on purpose.
    StaticJsonDocument<640> doc;
    doc["machine_id"] = g_mqtt_client_id;
    doc["exception"]  = ev->exception_code;
    doc["credits"]    = ev->credits;
    doc["coin_in"]    = ev->coin_in;
    doc["coin_out"]   = ev->coin_out;
    doc["state"]      = (int)ev->state;
    doc["aft_status"] = ev->aft_status;
    doc["bv_enabled"]      = ev->bv_enabled;
    doc["printer_enabled"] = ev->printer_enabled;
    // Machine-diagnostics fields (2026-09-17) -- see sas_polling.h's
    // MachineEvent/getters for the "0/false may mean not-yet-known" caveat.
    doc["enabled_features"]      = ev->enabled_features;
    doc["cash_out_limit_cents"]  = ev->cash_out_limit_cents;
    doc["aft_transfer_limit_cents"] = ev->aft_transfer_limit_cents;
    doc["rte_guard_ok"]          = ev->rte_guard_ok;
    doc["bill_config_ok"]        = ev->bill_config_ok;
    doc["door_open"]             = ev->door_open;
    doc["last_cycle_overrun_ms"] = ev->last_cycle_overrun_ms;
    // Identity/config fields (2026-09-17) -- for the single-machine "read
    // everything" technical view (frontend/diagnostics). Empty string /
    // 0 / false = not yet queried, same caveat as above.
    if (ev->serial_number[0] != '\0') doc["serial_number"] = ev->serial_number;
    if (ev->sas_version[0]   != '\0') doc["sas_version"]   = ev->sas_version;
    doc["denom_code"]         = ev->denom_code;
    doc["denom_value_x10000"] = ev->denom_value_x10000;
    doc["asset_number"]       = ev->asset_number;
    doc["aft_registered"]     = ev->aft_registered;
    if (ev->txn_id[0] != '\0') doc["txn_id"] = ev->txn_id;

    char buf[640];
    serializeJson(doc, buf, sizeof(buf));
    s_mqtt.publish(g_topic_telemetry, buf);
    led_pulse_network();  // real outbound MQTT traffic -- see led_indicator.h
}

// ── Network Task main loop (Core 0) ───────────────────────────

void mqtt_network_task(void* pvParameters) {
    ESP_LOGI(TAG, "Network Task started on Core %d", xPortGetCoreID());

    mqtt_reconnect();

    while (true) {
        if (!s_mqtt.connected()) {
            mqtt_reconnect();
        }
        s_mqtt.loop();  // Process keep-alive and incoming messages

        // SAS identity (LP 0x54) may still be querying when MQTT first
        // connects (up to ~1.8s after boot) -- keep checking each loop
        // tick until it's known and published; a no-op cheap check once
        // s_identity_published latches true.
        publish_identity_if_known();

        // Drain Report_Queue – process up to 10 events per iteration
        MachineEvent ev;
        int processed = 0;
        while (processed < 10 &&
               xQueueReceive(g_report_queue, &ev, 0) == pdTRUE) {
            serialize_and_publish(&ev);
            processed++;
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void mqtt_client_init() {
    s_mqtt.setServer(MQTT_BROKER_HOST, MQTT_BROKER_PORT);
    s_mqtt.setCallback(on_message);
    s_mqtt.setKeepAlive(MQTT_KEEPALIVE);
    // 2026-09-17: bumped from 512 -- telemetry payload itself can now reach
    // ~450-500 bytes (identity/config fields added for the single-machine
    // diagnostics view), and this buffer must also fit the MQTT fixed/
    // variable header + topic string on top of the JSON payload, not just
    // the payload alone. 2026-09-18: bumped again (768->896) alongside the
    // JSON buffer bump above (2 more telemetry fields).
    s_mqtt.setBufferSize(896);
}

void mqtt_task_start() {
    xTaskCreatePinnedToCore(
        mqtt_network_task,
        "MQTT_NET",
        TASK_STACK_NETWORK,
        NULL,
        5,     // Medium priority
        NULL,
        0      // Core 0
    );
}

void mqtt_publish_telemetry(const char* json) {
    s_mqtt.publish(g_topic_telemetry, json);
}
