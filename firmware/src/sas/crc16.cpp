// =============================================================
// crc16.cpp – CRC-16 implementation for SAS protocol
//
// Ported verbatim from SAS 6.02 spec Section 5.1, Figure 5.1
// ("byte-oriented tableless algorithm", nibble-based). Confirmed
// against the spec text: initial seed value is zero (Section 5.2),
// NOT 0xFFFF – a prior CRC-16/CCITT-FALSE implementation here was
// wrong on both the seed and the reflected/non-reflected bit order.
// Magic constant 0x1081 (octal 010201 in the original) is derived
// from the CRC polynomial x^16+x^12+x^5+1.
// =============================================================
#include "crc16.h"

uint16_t crc16_sas(const uint8_t* data, size_t length) {
    uint16_t crc = 0;  // spec Section 5.2: initial seed value of zero
    for (size_t i = 0; i < length; i++) {
        unsigned c = data[i];
        unsigned q = (crc ^ c) & 0x0F;
        crc = (crc >> 4) ^ (q * 0x1081);
        q = (crc ^ (c >> 4)) & 0x0F;
        crc = (crc >> 4) ^ (q * 0x1081);
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
