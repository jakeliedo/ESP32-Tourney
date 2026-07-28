// =============================================================
// crc16.cpp – CRC-16 implementation for SAS protocol
// =============================================================
#include "crc16.h"

// SAS uses CRC-16/CCITT-FALSE: poly=0x1021, init=0xFFFF, refIn=false
static const uint16_t CRC16_POLY = 0x1021;
static const uint16_t CRC16_INIT = 0xFFFF;

uint16_t crc16_sas(const uint8_t* data, size_t length) {
    uint16_t crc = CRC16_INIT;
    for (size_t i = 0; i < length; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int bit = 0; bit < 8; bit++) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ CRC16_POLY;
            } else {
                crc <<= 1;
            }
        }
    }
    return crc;
}

void crc16_append(uint8_t* frame, size_t length) {
    uint16_t crc = crc16_sas(frame, length);
    frame[length]     = (uint8_t)(crc & 0xFF);         // low byte first
    frame[length + 1] = (uint8_t)((crc >> 8) & 0xFF);  // high byte
}

bool crc16_verify(const uint8_t* frame, size_t length) {
    if (length < 3) return false;
    uint16_t calculated = crc16_sas(frame, length - 2);
    uint16_t received   = (uint16_t)frame[length - 2] | ((uint16_t)frame[length - 1] << 8);
    return calculated == received;
}
