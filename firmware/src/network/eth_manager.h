#pragma once
// =============================================================
// eth_manager.h – DM9051 Ethernet via ETH.h (Arduino Core v3.x)
// Uses lwIP stack routed through DM9051 as MAC/PHY adapter
// =============================================================
#include <Arduino.h>

/**
 * Initialise DM9051 module via SPI.
 * Configures pins from config.h and starts DHCP negotiation.
 * Must be called before mqtt_client_init().
 * @return true when IP address is acquired
 */
bool eth_manager_init();

/**
 * Returns true if Ethernet link is up and IP is valid.
 */
bool eth_manager_is_connected();

/**
 * Returns current IP address as string (empty string if not connected).
 */
String eth_manager_get_ip();
