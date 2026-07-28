// =============================================================
// eth_manager.cpp – W5500 Ethernet initialisation
//
// CRITICAL: Uses ETH.h from Arduino Core v3.x which routes all
// traffic through ESP32's lwIP stack, solving the "Two TCP Stacks
// Problem". Do NOT use the Ethernet.h (Wiznet) library alongside
// ESP32 WiFi/MQTT libraries.
// =============================================================
#include "eth_manager.h"
#include "../../include/config.h"

#include <ETH.h>
#include <SPI.h>
#include <esp_log.h>

static const char* TAG  = "ETH_MGR";
static bool s_eth_connected = false;

// Arduino Core v3.x ETH event handler
static void eth_event_handler(arduino_event_id_t event,
                               arduino_event_info_t info) {
    switch (event) {
        case ARDUINO_EVENT_ETH_START:
            ESP_LOGI(TAG, "ETH started");
            ETH.setHostname(MQTT_CLIENT_ID);
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
    Network.onEvent(eth_event_handler);

    // Begin W5500 via SPI – Arduino Core v3.x ETH.h API
    // W5500 acts as MAC/PHY only; lwIP handles TCP/IP stack
    ETH.begin(ETH_PHY_W5500,
              /* phy_addr  */ 1,
              /* cs        */ ETH_CS_PIN,
              /* irq       */ ETH_INT_PIN,
              /* rst       */ ETH_RST_PIN,
              /* spi_bus   */ VSPI,
              /* spi_freq  */ ETH_SPI_FREQ,
              /* miso      */ ETH_MISO_PIN,
              /* mosi      */ ETH_MOSI_PIN,
              /* sclk      */ ETH_SCLK_PIN);

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
