#pragma once
// =============================================================
// mqtt_client.h – MQTT over Ethernet (Core 0, medium priority)
// Publishes telemetry from Report_Queue; receives server commands
// =============================================================
#include <Arduino.h>
#include "../sas/sas_polling.h"

/**
 * Initialise MQTT client and connect to broker.
 * Must be called after eth_manager_init().
 */
void mqtt_client_init();

/**
 * Start the Network & API FreeRTOS task pinned to Core 0.
 * This task drives the MQTT loop, processes Report_Queue, and
 * dispatches incoming server commands to Command_Queue.
 */
void mqtt_task_start();

/**
 * Entry point for Network task (do not call directly).
 */
void mqtt_network_task(void* pvParameters);

/**
 * Publish a raw JSON string to the telemetry topic.
 * Thread-safe (called from Network task only).
 */
void mqtt_publish_telemetry(const char* json);
