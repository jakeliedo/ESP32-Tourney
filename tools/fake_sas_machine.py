#!/usr/bin/env python3
"""
fake_sas_machine.py -- PC-side "fake slot machine" for firmware bring-up.

Plays the EGM (slot machine) side of the SAS 6.02 link so the ESP32
firmware's SAS UART can be exercised end-to-end (bit9 + CRC) *before*
ever connecting to a real machine. Wire a USB-TTL adapter to the
ESP32's GPIO18 (its TX) / GPIO19 (its RX) directly -- MAX3232 is
bypassed on purpose here, since this stage tests protocol/CRC
correctness, not RS232 voltage levels (see hardware/wiring_guide.txt
and the electrical bring-up step with a logic analyzer for that).

Technique: identical to SASpyTourney/libs/saspy/sas.py's _conf_port()
/ _conf_event_port() -- pyserial's PARITY_MARK/PARITY_SPACE map onto
real UART hardware on the PC side (the 16550-class UART/USB-serial
chip genuinely supports fixed-parity framing, unlike the ESP32's
UART peripheral -- see the ETH01-EVO firmware's sas_polling.cpp for
why the ESP32 side has to fake bit9 via EVEN/ODD selection instead).

STATUS: first draft, NOT yet run against real hardware (needs a
physical board + USB-TTL adapter -- test-plan step (d), after steps
(a)-(c) pass). The byte-timing heuristic in _read_frame() below is
the part most likely to need tuning once real bytes are on the wire;
watch for it with a logic analyzer running alongside the first runs.
"""
import argparse
import sys
import time

import serial

BAUD = 19200
INTER_BYTE_TIMEOUT_S = 0.010  # SAS spec Section 2.3.2 allows up to 5ms
# between bytes of one frame; use a bit more margin while probing for
# "did the next byte already arrive" during mode switches below.

# ── CRC -- ported from the same SAS 6.02 spec Section 5.1 Figure 5.1 ──
# reference the firmware's crc16.cpp now implements (seed=0, nibble
# based). Kept as a straight port here (not saspy's table form) so a
# mismatch between this script and the firmware is a real signal, not
# just two independently-written copies of the same known-good code.
def crc16_sas(data: bytes) -> int:
    crc = 0
    for c in data:
        q = (crc ^ c) & 0x0F
        crc = (crc >> 4) ^ (q * 0x1081)
        q = (crc ^ (c >> 4)) & 0x0F
        crc = (crc >> 4) ^ (q * 0x1081)
    return crc & 0xFFFF


def append_crc(payload: bytes) -> bytes:
    crc = crc16_sas(payload)
    return payload + bytes([crc & 0xFF, (crc >> 8) & 0xFF])  # low byte first


def bcd_encode(value: int, num_bytes: int) -> bytes:
    out = bytearray(num_bytes)
    for i in range(num_bytes - 1, -1, -1):
        out[i] = (value % 10) | (((value // 10) % 10) << 4)
        value //= 100
    return bytes(out)


class FakeSasMachine:
    def __init__(self, port: str, address: int = 0x01):
        self.address = address
        self.ser = serial.Serial(port=port, baudrate=BAUD, timeout=INTER_BYTE_TIMEOUT_S)
        self.credits = 100_00  # $100.00 in cents-style integer credits (matches config.h convention)

    def close(self):
        self.ser.close()

    # ── Low-level receive: mirror saspy's mode-switching technique ──
    def _read_byte(self, parity):
        self.ser.parity = parity
        b = self.ser.read(1)
        return b[0] if b else None

    def _read_frame(self):
        """
        Read one incoming frame from the host.

        Heuristic (see module docstring): read the first byte in
        PARITY_MARK (expecting bit9=1, i.e. an address byte). Our
        firmware's General Poll sends the address byte TWICE, both
        with bit9=1 -- so keep reading in MARK as long as bytes keep
        arriving promptly; the first byte that DOESN'T arrive within
        INTER_BYTE_TIMEOUT_S while still in MARK mode means the
        address portion is over and we should switch to SPACE mode
        for the rest of the frame (command + payload + CRC).
        """
        first = self._read_byte(serial.PARITY_MARK)
        if first is None:
            return None
        addr_bytes = [first]

        # Peek for a possible second address byte (General Poll).
        second = self._read_byte(serial.PARITY_MARK)
        if second is not None and second == first:
            addr_bytes.append(second)
            return {"type": "general_poll", "address": first}

        # Not a General Poll -- `second` (if any) is actually the
        # first DATA byte, but we read it under MARK; that's fine,
        # MARK vs SPACE only matters for what WE transmit, receiving
        # doesn't require matching mode (see sas_polling.cpp's RX
        # side: it never bothers with parity mode either).
        data = bytearray()
        if second is not None:
            data.append(second)

        # Drain the rest of the frame until inter-byte gap exceeds
        # the SAS Section 2.3.2 limit -- i.e. the frame is done.
        while True:
            b = self._read_byte(serial.PARITY_SPACE)
            if b is None:
                break
            data.append(b)

        if not data:
            return None
        return {"type": "long_poll", "address": first, "cmd": data[0], "raw": bytes(data)}

    # ── Low-level transmit: real MARK/SPACE, exactly like saspy ──
    def _send(self, address_byte: int, data_bytes: bytes):
        self.ser.parity = serial.PARITY_MARK
        self.ser.write(bytes([address_byte]))
        self.ser.flush()
        self.ser.parity = serial.PARITY_SPACE
        if data_bytes:
            self.ser.write(data_bytes)
            self.ser.flush()

    # ── Response builders for the long polls sas_commands.cpp sends ──
    def respond_general_poll(self):
        # Per spec Section 1.2.1 the EGM always clears bit9 on its own
        # bytes -- one PARITY_SPACE byte here would be most correct,
        # but since we never call _send with an address-only frame,
        # just write the single exception byte directly in SPACE.
        self.ser.parity = serial.PARITY_SPACE
        self.ser.write(bytes([0x00]))  # SAS_EXC_NO_ACTIVITY
        self.ser.flush()

    def respond_ack(self, addr: int):
        self._send(addr, b"")  # ACK = echo address alone

    def respond_credits(self, addr: int):
        payload = bytes([addr, 0x1A]) + bcd_encode(self.credits, 4)
        self._send(addr, append_crc(payload)[2:])  # addr already sent by _send

    def respond_meters(self, addr: int):
        coin_in, coin_out, games_played = 500_00, 480_00, 42
        payload = (
            bytes([addr, 0xAF])
            + bcd_encode(coin_in, 4)
            + bcd_encode(coin_out, 4)
            + bcd_encode(games_played, 4)
        )
        self._send(addr, append_crc(payload)[2:])

    def respond_aft(self, addr: int, cmd_bytes: bytes):
        # Minimal AFT ack: status=SUCCESS(0x00), echo amount from the
        # request (bytes 6..9 of the request payload are the BCD
        # amount per sas_build_lp_aft), no transaction ID round-trip
        # yet -- extend once step (e) needs a fuller AFT exchange.
        amount = cmd_bytes[6:10] if len(cmd_bytes) >= 10 else bcd_encode(0, 4)
        payload = bytes([addr, 0x72, 0x00]) + amount
        self._send(addr, append_crc(payload)[2:])

    def run(self):
        print(f"[fake_sas_machine] listening on {self.ser.port} @ {BAUD} baud, address=0x{self.address:02X}")
        while True:
            frame = self._read_frame()
            if frame is None:
                continue
            if frame["type"] == "general_poll":
                if frame["address"] != self.address and (frame["address"] & 0x7F) != self.address:
                    continue
                self.respond_general_poll()
                continue

            addr, cmd = frame["address"], frame["cmd"]
            if addr != self.address:
                continue
            print(f"[fake_sas_machine] long poll cmd=0x{cmd:02X} raw={frame['raw'].hex()}")
            if cmd in (0x01, 0x02, 0x06, 0x07):
                self.respond_ack(addr)
            elif cmd == 0x1A:
                self.respond_credits(addr)
            elif cmd in (0xAF, 0x6F):
                self.respond_meters(addr)
            elif cmd == 0x72:
                self.respond_aft(addr, frame["raw"])
            else:
                print(f"[fake_sas_machine] unhandled cmd 0x{cmd:02X}, ignoring")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("port", help="Serial port of the USB-TTL adapter, e.g. COM5")
    ap.add_argument("--address", type=lambda s: int(s, 0), default=0x01,
                     help="SAS address to answer to (default 0x01, matches config.h SAS_MACHINE_ADDRESS)")
    args = ap.parse_args()

    machine = FakeSasMachine(args.port, args.address)
    try:
        machine.run()
    except KeyboardInterrupt:
        print("\n[fake_sas_machine] stopped")
    finally:
        machine.close()


if __name__ == "__main__":
    sys.exit(main())
