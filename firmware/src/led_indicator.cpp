// =============================================================
// led_indicator.cpp – Onboard activity LEDs (D1 RED / D2 GREEN)
// =============================================================
#include "led_indicator.h"
#include "../include/config.h"
#include <Arduino.h>

static bool s_serial_state  = false;  // false = off
static bool s_network_state = false;

void led_indicator_init() {
    pinMode(LED_SERIAL_PIN,  OUTPUT);
    pinMode(LED_NETWORK_PIN, OUTPUT);
    digitalWrite(LED_SERIAL_PIN,  HIGH);  // active-LOW: HIGH = off
    digitalWrite(LED_NETWORK_PIN, HIGH);
    s_serial_state  = false;
    s_network_state = false;
}

void led_pulse_serial() {
    s_serial_state = !s_serial_state;
    digitalWrite(LED_SERIAL_PIN, s_serial_state ? LOW : HIGH);
}

void led_pulse_network() {
    s_network_state = !s_network_state;
    digitalWrite(LED_NETWORK_PIN, s_network_state ? LOW : HIGH);
}
