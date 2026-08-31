#pragma once
// =============================================================
// crc16.h – CRC-16 for SAS protocol frame validation
// Direct port of the official reference algorithm (SAS 6.02 spec,
// Section 5.1 Figure 5.1): nibble-based, tableless, seed=0.
// =============================================================
#include <stdint.h>
#include <stddef.h>

/**
 * Calculate CRC-16 checksum over a byte buffer.
 * @param data   Pointer to byte array
 * @param length Number of bytes to process
 * @return 16-bit CRC value (little-endian append order: low byte first)
 */
uint16_t crc16_sas(const uint8_t* data, size_t length);

/**
 * Append CRC-16 bytes to an outgoing SAS frame in-place.
 * The buffer must have at least 2 extra bytes beyond `length`.
 * @param frame  Frame buffer (with space for 2 trailing CRC bytes)
 * @param length Number of payload bytes (CRC appended at [length] and [length+1])
 */
void crc16_append(uint8_t* frame, size_t length);

/**
 * Verify CRC-16 on a received SAS frame.
 * The last 2 bytes of the buffer are expected to be the CRC.
 * @param frame  Full received frame including CRC bytes
 * @param length Total frame length (payload + 2 CRC bytes)
 * @return true if CRC matches, false otherwise
 */
bool crc16_verify(const uint8_t* frame, size_t length);
