#pragma once
// =============================================================
// led_indicator.h – Onboard activity LEDs (D1 RED / D2 GREEN)
//
// Pure visual feedback, no logic depends on these. Each call TOGGLES the
// corresponding LED (not "turn on + auto-off timer") -- with real SAS
// polling running continuously every 40ms and MQTT publishing on every
// telemetry event, a toggle-per-event is what actually produces a visible
// blink: it's a lightweight square wave in sync with real traffic, so it
// keeps flickering exactly as long as that traffic keeps flowing and
// visibly freezes solid the moment it stops (itself a useful "link died"
// signal) -- no separate timer/task needed to turn a pulse back off.
// =============================================================

// Call once from setup(), after Serial.begin(), before either task starts.
void led_indicator_init();

// Call on every real byte transmitted/received on the SAS UART
// (see sas_send_byte()/sas_receive()/sas_general_poll() in sas_polling.cpp).
void led_pulse_serial();

// Call on every real MQTT publish/received message
// (see serialize_and_publish()/on_message() in mqtt_client.cpp).
void led_pulse_network();
