// Unit test for crc16_sas() – pure logic, no hardware needed.
// Includes the real firmware source directly so this test always
// exercises the exact code that ships, not a re-typed copy.
#include <unity.h>
#include <stdint.h>
#include <stddef.h>
#include "../../src/sas/crc16.cpp"

// Independent reference: reflected bit-by-bit CRC-16/CCITT
// (poly 0x8408, init 0) – same family as SASpyTourney/libs/saspy's
// table (built from seed 0x8408). Structurally different from the
// spec's nibble-based algorithm above, so agreement between the two
// is real cross-validation, not a self-comparison.
// Hand-verified for data=[0x01]: both give 0x1189.
static uint16_t crc16_reflected_reference(const uint8_t* data, size_t len) {
    uint16_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int b = 0; b < 8; b++) {
            crc = (crc & 1) ? (uint16_t)((crc >> 1) ^ 0x8408) : (uint16_t)(crc >> 1);
        }
    }
    return crc;
}

void test_crc_matches_reflected_reference_single_bytes(void) {
    for (int v = 0; v <= 255; v++) {
        uint8_t byte = (uint8_t)v;
        uint16_t got  = crc16_sas(&byte, 1);
        uint16_t want = crc16_reflected_reference(&byte, 1);
        TEST_ASSERT_EQUAL_HEX16(want, got);
    }
}

void test_crc_matches_reflected_reference_multi_byte_frames(void) {
    static const uint8_t frame_lp1a[]  = {0x01, 0x1A};
    static const uint8_t frame_lp01[]  = {0x01, 0x01};
    static const uint8_t frame_gpoll[] = {0x82};
    static const uint8_t frame_aft[]   = {0x01, 0x72, 0x05, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE};

    struct { const uint8_t* data; size_t len; } cases[] = {
        {frame_lp1a,  sizeof(frame_lp1a)},
        {frame_lp01,  sizeof(frame_lp01)},
        {frame_gpoll, sizeof(frame_gpoll)},
        {frame_aft,   sizeof(frame_aft)},
    };

    for (auto& c : cases) {
        uint16_t got  = crc16_sas(c.data, c.len);
        uint16_t want = crc16_reflected_reference(c.data, c.len);
        TEST_ASSERT_EQUAL_HEX16(want, got);
    }
}

void test_crc_seed_is_zero_not_0xffff(void) {
    // Spec Section 5.2: "initial seed value of zero." An empty buffer
    // must CRC to 0x0000 - would fail with the old, wrong
    // CRC-16/CCITT-FALSE (init=0xFFFF) implementation this replaced.
    TEST_ASSERT_EQUAL_HEX16(0x0000, crc16_sas(nullptr, 0));
}

void test_crc_append_and_verify_round_trip(void) {
    uint8_t frame[4] = {0x01, 0x1A, 0, 0};
    crc16_append(frame, 2);
    TEST_ASSERT_TRUE(crc16_verify(frame, 4));
    frame[0] ^= 0xFF;  // corrupt
    TEST_ASSERT_FALSE(crc16_verify(frame, 4));
}

int main(int argc, char** argv) {
    UNITY_BEGIN();
    RUN_TEST(test_crc_matches_reflected_reference_single_bytes);
    RUN_TEST(test_crc_matches_reflected_reference_multi_byte_frames);
    RUN_TEST(test_crc_seed_is_zero_not_0xffff);
    RUN_TEST(test_crc_append_and_verify_round_trip);
    return UNITY_END();
}
