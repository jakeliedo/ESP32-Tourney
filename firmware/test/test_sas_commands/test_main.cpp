// Unit test for the machine-diagnostics Long Poll builders/parsers added
// 2026-09-17 (LP 0xA0 Send Enabled Features, LP 0xA4 Send Cash Out Limit,
// LP 0x0E Enable/Disable Real Time Event Reporting). Includes the real
// firmware source directly (same trick as test_crc16) so this test always
// exercises the exact code that ships, not a re-typed copy.
//
// This is the first unit test of any sas_commands.cpp builder/parser pair
// -- crc16.cpp is included first since sas_commands.cpp depends on it.
#include <unity.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "../../src/sas/crc16.cpp"
#include "../../src/sas/sas_commands.cpp"

static const uint8_t ADDR = 0x01;

// ── LP 0xA0 – Send Enabled Features ──────────────────────────────

void test_enabled_features_request_frame_is_correct(void) {
    uint8_t buf[16] = {0};
    size_t len = sas_build_lp_enabled_features(buf, ADDR);

    TEST_ASSERT_EQUAL_UINT(6, len);
    TEST_ASSERT_EQUAL_HEX8(ADDR, buf[0]);
    TEST_ASSERT_EQUAL_HEX8(SAS_CMD_ENABLED_FEATURES, buf[1]);
    TEST_ASSERT_EQUAL_HEX8(0x00, buf[2]);  // game number BCD, MSB = 0000
    TEST_ASSERT_EQUAL_HEX8(0x00, buf[3]);
    TEST_ASSERT_TRUE(crc16_verify(buf, len));
}

void test_enabled_features_response_parses_all_three_bytes(void) {
    // [addr][0xA0][game#:2][features1][features2][features3][reserved:3][CRC:2]
    uint8_t buf[12] = {
        ADDR, SAS_CMD_ENABLED_FEATURES, 0x00, 0x00,
        0x80,  // Features1 bit7 = ticket redemption
        0x40,  // Features2 bit6 = AFT supported
        0x01,  // Features3 bit0 = 40ms poll rate guaranteed
        0x00, 0x00, 0x00,  // reserved
        0, 0,  // CRC filled below
    };
    crc16_append(buf, 10);

    SasEnabledFeaturesResponse resp = sas_parse_enabled_features(buf, sizeof(buf));
    TEST_ASSERT_TRUE(resp.valid);
    TEST_ASSERT_TRUE(resp.feature_bits & SAS_FEATURE_TICKET_REDEMPTION);
    TEST_ASSERT_TRUE(resp.feature_bits & SAS_FEATURE_AFT_SUPPORTED);
    TEST_ASSERT_TRUE(resp.feature_bits & SAS_FEATURE_MAX_POLL_RATE_40MS);
    // Combined value should be exactly features1 | features2<<8 | features3<<16
    TEST_ASSERT_EQUAL_HEX32(0x014080UL, resp.feature_bits);
}

void test_enabled_features_response_rejects_bad_crc(void) {
    uint8_t buf[12] = {
        ADDR, SAS_CMD_ENABLED_FEATURES, 0x00, 0x00,
        0x80, 0x40, 0x01, 0x00, 0x00, 0x00,
        0, 0,
    };
    crc16_append(buf, 10);
    buf[4] ^= 0xFF;  // corrupt a data byte after CRC was computed

    SasEnabledFeaturesResponse resp = sas_parse_enabled_features(buf, sizeof(buf));
    TEST_ASSERT_FALSE(resp.valid);
}

void test_enabled_features_response_rejects_wrong_cmd_byte(void) {
    uint8_t buf[12] = {
        ADDR, 0xA4 /* wrong cmd */, 0x00, 0x00,
        0x80, 0x40, 0x01, 0x00, 0x00, 0x00,
        0, 0,
    };
    crc16_append(buf, 10);

    SasEnabledFeaturesResponse resp = sas_parse_enabled_features(buf, sizeof(buf));
    TEST_ASSERT_FALSE(resp.valid);
}

void test_enabled_features_response_rejects_truncated_frame(void) {
    uint8_t buf[11] = {
        ADDR, SAS_CMD_ENABLED_FEATURES, 0x00, 0x00,
        0x80, 0x40, 0x01, 0x00, 0x00,
        0, 0,
    };  // only 11 bytes -- one short of the required 12

    SasEnabledFeaturesResponse resp = sas_parse_enabled_features(buf, sizeof(buf));
    TEST_ASSERT_FALSE(resp.valid);
}

// ── LP 0xA4 – Send Cash Out Limit ────────────────────────────────

void test_cash_out_limit_request_frame_is_correct(void) {
    uint8_t buf[16] = {0};
    size_t len = sas_build_lp_cash_out_limit(buf, ADDR);

    TEST_ASSERT_EQUAL_UINT(6, len);
    TEST_ASSERT_EQUAL_HEX8(ADDR, buf[0]);
    TEST_ASSERT_EQUAL_HEX8(SAS_CMD_CASH_OUT_LIMIT, buf[1]);
    TEST_ASSERT_EQUAL_HEX8(0x00, buf[2]);
    TEST_ASSERT_EQUAL_HEX8(0x00, buf[3]);
    TEST_ASSERT_TRUE(crc16_verify(buf, len));
}

void test_cash_out_limit_response_parses_bcd_value(void) {
    // [addr][0xA4][game#:2][cash_out_limit:2 BCD MSB-first][CRC:2]
    // 1234 (BCD) -> raw value 1234 in accounting-denom units.
    uint8_t buf[8] = {
        ADDR, SAS_CMD_CASH_OUT_LIMIT, 0x00, 0x00,
        0x12, 0x34,  // BCD 1234, MSB first
        0, 0,
    };
    crc16_append(buf, 6);

    SasCashOutLimitResponse resp = sas_parse_cash_out_limit(buf, sizeof(buf));
    TEST_ASSERT_TRUE(resp.valid);
    TEST_ASSERT_EQUAL_UINT32(1234, resp.cash_out_limit_raw);
}

void test_cash_out_limit_response_rejects_bad_crc(void) {
    uint8_t buf[8] = {
        ADDR, SAS_CMD_CASH_OUT_LIMIT, 0x00, 0x00,
        0x12, 0x34,
        0, 0,
    };
    crc16_append(buf, 6);
    buf[5] ^= 0xFF;

    SasCashOutLimitResponse resp = sas_parse_cash_out_limit(buf, sizeof(buf));
    TEST_ASSERT_FALSE(resp.valid);
}

void test_cash_out_limit_response_rejects_truncated_frame(void) {
    uint8_t buf[7] = { ADDR, SAS_CMD_CASH_OUT_LIMIT, 0x00, 0x00, 0x12, 0, 0 };
    SasCashOutLimitResponse resp = sas_parse_cash_out_limit(buf, sizeof(buf));
    TEST_ASSERT_FALSE(resp.valid);
}

// ── LP 0x0E – Enable/Disable Real Time Event Reporting ───────────

void test_rte_reporting_disable_frame_is_correct(void) {
    uint8_t buf[16] = {0};
    size_t len = sas_build_lp_rte_reporting(buf, ADDR, false);

    TEST_ASSERT_EQUAL_UINT(5, len);
    TEST_ASSERT_EQUAL_HEX8(ADDR, buf[0]);
    TEST_ASSERT_EQUAL_HEX8(SAS_CMD_RTE_REPORTING, buf[1]);
    TEST_ASSERT_EQUAL_HEX8(0x00, buf[2]);  // 00 = disable
    TEST_ASSERT_TRUE(crc16_verify(buf, len));
}

void test_rte_reporting_enable_frame_is_correct(void) {
    uint8_t buf[16] = {0};
    size_t len = sas_build_lp_rte_reporting(buf, ADDR, true);

    TEST_ASSERT_EQUAL_UINT(5, len);
    TEST_ASSERT_EQUAL_HEX8(0x01, buf[2]);  // 01 = enable
    TEST_ASSERT_TRUE(crc16_verify(buf, len));
}

int main(int argc, char** argv) {
    UNITY_BEGIN();
    RUN_TEST(test_enabled_features_request_frame_is_correct);
    RUN_TEST(test_enabled_features_response_parses_all_three_bytes);
    RUN_TEST(test_enabled_features_response_rejects_bad_crc);
    RUN_TEST(test_enabled_features_response_rejects_wrong_cmd_byte);
    RUN_TEST(test_enabled_features_response_rejects_truncated_frame);
    RUN_TEST(test_cash_out_limit_request_frame_is_correct);
    RUN_TEST(test_cash_out_limit_response_parses_bcd_value);
    RUN_TEST(test_cash_out_limit_response_rejects_bad_crc);
    RUN_TEST(test_cash_out_limit_response_rejects_truncated_frame);
    RUN_TEST(test_rte_reporting_disable_frame_is_correct);
    RUN_TEST(test_rte_reporting_enable_frame_is_correct);
    return UNITY_END();
}
