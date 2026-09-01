#include <Arduino.h>

// WT32-ETH01-Evo confirmed LED map (from schematic S3-ETH-MAIN Rev V1.1):
//   GPIO5  D1 RED   (EXT_RXD line, 1K pull to +3V3)
//   GPIO2  D2 GREEN (EXT_TXD line, 1K pull to +3V3)
//   D3 RED always-on power indicator (tied to +3V3, no GPIO)
//
// GPIO2 is an ESP32-C3 strapping pin but is safe as output after boot.
// Active-LOW: analogWrite(pin, 0) = full brightness, 255 = off.

#define LED_RED_PIN   5
#define LED_GREEN_PIN 2

// Sine fade: period = 1 s, active-LOW (invert value)
static inline int sineLevel(uint32_t offsetMs) {
    float t = (float)(offsetMs % 1000) / 1000.0f;
    float v = (1.0f - cosf(t * TWO_PI)) * 0.5f;  // 0..1
    return 255 - (int)(v * 255);                   // invert for active-LOW
}

void setup() {
    Serial.begin(115200);
    pinMode(LED_RED_PIN,   OUTPUT);
    pinMode(LED_GREEN_PIN, OUTPUT);
    analogWrite(LED_RED_PIN,   255);  // off
    analogWrite(LED_GREEN_PIN, 255);  // off
    Serial.println("LED fade — GPIO5 RED / GPIO2 GREEN, 1 s sine, 500 ms offset");
}

void loop() {
    uint32_t now = millis();
    analogWrite(LED_RED_PIN,   sineLevel(now));
    analogWrite(LED_GREEN_PIN, sineLevel(now + 500));  // half-cycle offset
    delay(8);
}
