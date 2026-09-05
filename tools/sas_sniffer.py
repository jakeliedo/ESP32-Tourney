#!/usr/bin/env python3
"""
sas_sniffer.py -- passive SAS 6.02 RS232 line monitor.

Taps one side of the SAS link (e.g. the slot machine's own TX line via
a second USB-TTL/PL2303 adapter) to show whether *anything* is on the
wire, independent of the EVO board's own SAS UART/firmware. Useful when
the EVO's own serial log shows "no response" and you need to know
whether that's an EVO-side problem or the machine really isn't
answering at all.

Framing note (see fake_sas_machine.py's docstring for the full
explanation): a real PC UART, unlike the ESP32's, genuinely supports a
fixed hardware parity mode. Configuring the port for a FIXED parity
(default: SPACE, i.e. bit9=0) keeps every byte's start/stop-bit timing
correctly aligned regardless of whether that particular byte's real
bit9 was 0 or 1 -- so all 8 data bits still come through correctly for
every byte, address or data. You just can't trust the parity-error
flag (not surfaced by pyserial anyway) to tell you which bytes were
"really" address bytes; this script guesses that from position (first
byte(s) of a frame, split on the inter-byte timing gap) instead.

Usage:
    python sas_sniffer.py COM8
    python sas_sniffer.py COM8 --address 0x01 --parity mark
"""
import argparse
import sys
import time

import serial

BAUD = 19200
INTER_BYTE_TIMEOUT_S = 0.010  # SAS spec allows up to 5ms between bytes
                               # of one frame; same margin fake_sas_machine.py uses.
IDLE_WARN_S = 5.0             # print a "still silent" heartbeat if nothing arrives

PARITY_MAP = {
    "none":  serial.PARITY_NONE,
    "odd":   serial.PARITY_ODD,
    "even":  serial.PARITY_EVEN,
    "mark":  serial.PARITY_MARK,
    "space": serial.PARITY_SPACE,
}


# ── CRC -- ported straight from fake_sas_machine.py / firmware crc16.cpp ──
def crc16_sas(data: bytes) -> int:
    crc = 0
    for c in data:
        q = (crc ^ c) & 0x0F
        crc = (crc >> 4) ^ (q * 0x1081)
        q = (crc ^ (c >> 4)) & 0x0F
        crc = (crc >> 4) ^ (q * 0x1081)
    return crc & 0xFFFF


def crc_ok(frame: bytes) -> bool:
    if len(frame) < 3:
        return False
    payload, crc_lo, crc_hi = frame[:-2], frame[-2], frame[-1]
    return crc16_sas(payload) == (crc_hi << 8 | crc_lo)


def classify(frame: bytes, expect_addr: int) -> str:
    if not frame:
        return "empty"
    addr = frame[0] & 0x7F
    if addr == expect_addr:
        tag = f"addr=0x{addr:02X} (matches --address)"
    else:
        tag = f"addr=0x{addr:02X}"
    if len(frame) >= 3:
        tag += " CRC_OK" if crc_ok(frame) else " CRC_FAIL"
    return tag


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", help="Serial port of the sniffing adapter, e.g. COM8")
    ap.add_argument("--baud", type=int, default=BAUD)
    ap.add_argument("--address", type=lambda s: int(s, 0), default=0x01,
                     help="SAS address to highlight when seen (default 0x01, matches config.h SAS_MACHINE_ADDRESS)")
    ap.add_argument("--parity", choices=PARITY_MAP.keys(), default="space",
                     help="Fixed UART parity to frame bytes with (default: space). "
                          "Doesn't affect which 8 data bits you see -- only try a "
                          "different value if you suspect the adapter/driver is "
                          "dropping bytes on parity mismatch instead of passing them through.")
    args = ap.parse_args()

    ser = serial.Serial(
        port=args.port,
        baudrate=args.baud,
        bytesize=serial.EIGHTBITS,
        parity=PARITY_MAP[args.parity],
        stopbits=serial.STOPBITS_ONE,
        timeout=0.05,
    )
    print(f"[sas_sniffer] listening on {args.port} @ {args.baud} baud, "
          f"parity={args.parity}, watching for address 0x{args.address:02X}")
    print("[sas_sniffer] Ctrl+C to stop\n")

    frame = bytearray()
    last_byte_time = None
    last_activity_time = time.monotonic()
    last_idle_warn = 0.0

    try:
        while True:
            b = ser.read(1)
            now = time.monotonic()

            if b:
                if frame and last_byte_time is not None and (now - last_byte_time) > INTER_BYTE_TIMEOUT_S:
                    ts = time.strftime("%H:%M:%S")
                    print(f"[{ts}] {len(frame):3d}B  {frame.hex(' ')}   [{classify(bytes(frame), args.address)}]")
                    frame.clear()
                frame += b
                last_byte_time = now
                last_activity_time = now
                last_idle_warn = now
            else:
                if frame and last_byte_time is not None and (now - last_byte_time) > INTER_BYTE_TIMEOUT_S:
                    ts = time.strftime("%H:%M:%S")
                    print(f"[{ts}] {len(frame):3d}B  {frame.hex(' ')}   [{classify(bytes(frame), args.address)}]")
                    frame.clear()

                if now - last_activity_time > IDLE_WARN_S and now - last_idle_warn > IDLE_WARN_S:
                    ts = time.strftime("%H:%M:%S")
                    print(f"[{ts}] ... still silent, no bytes in {now - last_activity_time:.0f}s")
                    last_idle_warn = now
    except KeyboardInterrupt:
        print("\n[sas_sniffer] stopped")
    finally:
        ser.close()


if __name__ == "__main__":
    sys.exit(main())
