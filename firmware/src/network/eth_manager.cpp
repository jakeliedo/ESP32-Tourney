// =============================================================
// eth_manager.cpp – DM9051 Ethernet initialisation
//
// CRITICAL: Uses ETH.h from Arduino Core v3.x which routes all
// traffic through ESP32's lwIP stack, solving the "Two TCP Stacks
// Problem". Do NOT use the Ethernet.h (Wiznet) library alongside
// ESP32 WiFi/MQTT libraries.
// =============================================================
#include "eth_manager.h"
#include "../../include/config.h"

#include <ETH.h>
#include <WiFi.h>       // WiFi.onEvent() is the generic network event registrar
#include <SPI.h>
#include <driver/spi_master.h>  // SPI2_HOST (spi_host_device_t)
#include <esp_log.h>

static const char* TAG  = "ETH_MGR";
static bool s_eth_connected = false;

// Arduino Core v3.x ETH event handler
// NOTE: this installed core version predates the Network/NetworkEvents
// API – events are registered via WiFi.onEvent() even for Ethernet-only
// projects (WiFiEvent_t event, no separate info struct needed here).
static void eth_event_handler(WiFiEvent_t event) {
    switch (event) {
        case ARDUINO_EVENT_ETH_START:
            ESP_LOGI(TAG, "ETH started");
            ETH.setHostname(MQTT_CLIENT_ID);
            // Static IP must be configured here (after netif is created by ETH.begin()).
            // Calling ETH.config() before ETH.begin() is a no-op for SPI Ethernet (DM9051)
            // because _eth_handle is null until ETH.begin() initialises the driver.
            ETH.config(IPAddress(ETH_STATIC_IP),
                       IPAddress(ETH_STATIC_GW),
                       IPAddress(ETH_STATIC_MASK));
            ESP_LOGI(TAG, "Static IP configured: 192.168.100.200/23");
            break;

        case ARDUINO_EVENT_ETH_CONNECTED:
            ESP_LOGI(TAG, "ETH cable connected");
            break;

        case ARDUINO_EVENT_ETH_GOT_IP:
            s_eth_connected = true;
            ESP_LOGI(TAG, "IP acquired: %s  speed:%dMbps  %s",
                     ETH.localIP().toString().c_str(),
                     ETH.linkSpeed(),
                     ETH.fullDuplex() ? "FULL_DUPLEX" : "HALF_DUPLEX");
            break;

        case ARDUINO_EVENT_ETH_DISCONNECTED:
            s_eth_connected = false;
            ESP_LOGW(TAG, "ETH cable disconnected");
            break;

        case ARDUINO_EVENT_ETH_STOP:
            s_eth_connected = false;
            ESP_LOGW(TAG, "ETH stopped");
            break;

        default:
            break;
    }
}

bool eth_manager_init() {
    WiFi.onEvent(eth_event_handler);

    // Begin DM9051 via SPI – Arduino Core v3.x ETH.h API
    // Signature: begin(type, phy_addr, cs, irq, rst, spi_host, sck, miso, mosi, spi_freq_mhz)
    ETH.begin(ETH_PHY_DM9051,
              /* phy_addr     */ 1,
              /* cs           */ ETH_CS_PIN,
              /* irq          */ ETH_INT_PIN,
              /* rst          */ ETH_RST_PIN,
              /* spi_host     */ SPI2_HOST,
              /* sck          */ ETH_SCLK_PIN,
              /* miso         */ ETH_MISO_PIN,
              /* mosi         */ ETH_MOSI_PIN,
              /* spi_freq_mhz */ ETH_SPI_FREQ_MHZ);

    // Wait up to 10 seconds for IP
    uint32_t timeout = millis() + 10000;
    while (!s_eth_connected && millis() < timeout) {
        delay(100);
    }
    return s_eth_connected;
}

bool eth_manager_is_connected() {
    return s_eth_connected;
}

String eth_manager_get_ip() {
    if (!s_eth_connected) return "";
    return ETH.localIP().toString();
}
