// =============================================================
// mqtt_client.cpp – MQTT Network Task (Core 0)
//
// Responsibilities:
//  - Maintain persistent MQTT connection to broker
//  - Drain Report_Queue → serialize to JSON → publish
//  - Receive command JSON from server → parse → push to Command_Queue
//  - Reconnect automatically on disconnect
// =============================================================
#include "mqtt_client.h"
#include "eth_manager.h"
#include "../../include/config.h"
#include "../sas/sas_polling.h"

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

// ── MQTT incoming message callback ────────────────────────────

static void on_message(char* topic, uint8_t* payload, unsigned int length) {
    if (strcmp(topic, MQTT_TOPIC_COMMANDS) != 0) return;

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

        if (s_mqtt.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS,
                           MQTT_TOPIC_STATUS, 1, true, "offline")) {
            ESP_LOGI(TAG, "MQTT connected");
            s_mqtt.subscribe(MQTT_TOPIC_COMMANDS);
            s_mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
        } else {
            ESP_LOGW(TAG, "MQTT connect failed rc=%d, retry in %lums",
                     s_mqtt.state(), (unsigned long)delay_ms);
            vTaskDelay(pdMS_TO_TICKS(delay_ms));
            if (delay_ms < 30000) delay_ms *= 2;
        }
    }
}

// ── Report_Queue → JSON serialiser ────────────────────────────

static void serialize_and_publish(const MachineEvent* ev) {
    StaticJsonDocument<256> doc;
    doc["machine_id"] = MQTT_CLIENT_ID;
    doc["exception"]  = ev->exception_code;
    doc["credits"]    = ev->credits;
    doc["coin_in"]    = ev->coin_in;
    doc["coin_out"]   = ev->coin_out;
    doc["state"]      = (int)ev->state;
    doc["aft_status"] = ev->aft_status;
    if (ev->txn_id[0] != '\0') doc["txn_id"] = ev->txn_id;

    char buf[256];
    serializeJson(doc, buf, sizeof(buf));
    s_mqtt.publish(MQTT_TOPIC_TELEMETRY, buf);
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
    s_mqtt.setBufferSize(512);
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
    s_mqtt.publish(MQTT_TOPIC_TELEMETRY, json);
}
