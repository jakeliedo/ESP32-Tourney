// Unit test for the SAS TX 9th-bit parity-selection algorithm used
// in sas_polling.cpp's uart_set_parity_for_bit9(). That function is
// `static` and lives in a file that pulls in Arduino/ESP-IDF/FreeRTOS
// headers unavailable on the host, so this test mirrors its decision
// rule verbatim and proves the underlying math holds for every byte:
// does picking EVEN/ODD this way actually produce the requested
// parity bit on real UART hardware?
#include <unity.h>
#include <stdint.h>

enum ParityChoice { PARITY_EVEN, PARITY_ODD };

// Mirrors sas_polling.cpp's uart_set_parity_for_bit9() decision rule.
static ParityChoice choose_parity_for_bit9(uint8_t byte, bool bit9_high) {
    bool even_gives_1 = (__builtin_popcount(byte) % 2) == 1;
    bool want_even = bit9_high ? even_gives_1 : !even_gives_1;
    return want_even ? PARITY_EVEN : PARITY_ODD;
}

// Ground truth for what a real UART's hardware parity generator
// would actually place on the wire for the given mode.
// EVEN parity bit = popcount(byte) % 2 (makes data+parity count even).
// ODD parity bit  = complement of that.
static bool actual_parity_bit(uint8_t byte, ParityChoice mode) {
    bool even_bit = (__builtin_popcount(byte) % 2) == 1;
    return (mode == PARITY_EVEN) ? even_bit : !even_bit;
}

void test_selection_produces_requested_bit9_for_every_byte(void) {
    for (int v = 0; v <= 255; v++) {
        uint8_t byte = (uint8_t)v;
        for (int want = 0; want <= 1; want++) {
            bool bit9_high = (want == 1);
            ParityChoice choice = choose_parity_for_bit9(byte, bit9_high);
            bool produced = actual_parity_bit(byte, choice);
            TEST_ASSERT_EQUAL_INT(bit9_high, produced);
        }
    }
}

void test_address_bytes_use_bit9_high(void) {
    // Address bytes (including both General Poll bytes) must select
    // the mode that yields bit9=1, regardless of the byte's value.
    uint8_t addresses[] = {0x01, 0x00, 0xFF, 0x82, 0x55, 0xAA};
    for (uint8_t addr : addresses) {
        ParityChoice choice = choose_parity_for_bit9(addr, true);
        TEST_ASSERT_TRUE(actual_parity_bit(addr, choice));
    }
}

void test_data_bytes_use_bit9_low(void) {
    uint8_t data_bytes[] = {0x1A, 0x00, 0xFF, 0x72, 0x55, 0xAA};
    for (uint8_t b : data_bytes) {
        ParityChoice choice = choose_parity_for_bit9(b, false);
        TEST_ASSERT_FALSE(actual_parity_bit(b, choice));
    }
}

int main(int argc, char** argv) {
    UNITY_BEGIN();
    RUN_TEST(test_selection_produces_requested_bit9_for_every_byte);
    RUN_TEST(test_address_bytes_use_bit9_high);
    RUN_TEST(test_data_bytes_use_bit9_low);
    return UNITY_END();
}
