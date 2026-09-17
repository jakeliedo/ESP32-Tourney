#!/usr/bin/env python3
"""
sas_command_reader.py -- passive SAS 6.02 command reader.

Taps ONE wire of a real SAS RS232 link (a real SAS host talking to a real
slot machine -- NOT this project's own ESP32/EVO firmware) and prints, for
every frame it sees, WHICH command was sent: the Long Poll name (Credits,
AFT Transfer, Meters, ...) and a few of its most important parameters, not
just raw hex.

This is read-only / observational. It never transmits anything on the bus.
See CLAUDE.md in this same folder for wiring instructions and known
limitations before using it.

Protocol tables (CRC, Long Poll layouts, exception codes) are ported
straight from this project's own already-verified firmware:
  firmware/src/sas/crc16.cpp
  firmware/src/sas/sas_commands.h / sas_commands.cpp
  firmware/src/sas/sas_polling.cpp
If that firmware later gains new commands, update LP_NAMES/EXCEPTION_NAMES
below to match.

Usage:
    python sas_command_reader.py COM8
    python sas_command_reader.py COM8 --direction machine --parity mark
    python sas_command_reader.py --selftest
"""
import argparse
import sys
import time

BAUD = 19200
INTER_BYTE_TIMEOUT_S = 0.010  # SAS allows up to 5ms between bytes of one frame
IDLE_WARN_S = 5.0


# ── CRC -- ported straight from firmware/src/sas/crc16.cpp ──────────────
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


# ── Field helpers, matching this project's own byte-order conventions ──
def bcd_to_int(data: bytes) -> int:
    """Packed BCD, MSB-byte-first (Section 2.2.3) -- same as bcd_to_uint32() in sas_commands.cpp."""
    value = 0
    for b in data:
        value = value * 100 + ((b >> 4) * 10 + (b & 0x0F))
    return value


def le_to_int(data: bytes) -> int:
    """'Binary' fields (asset number, meter codes, control masks) are LSB-first."""
    return int.from_bytes(data, "little")


# ── Long Poll command names -- ported from sas_commands.h ───────────────
LP_NAMES = {
    0x01: "Shutdown (Lock Out Play)",
    0x02: "Startup (Enable Play)",
    0x06: "Enable Bill Acceptor",
    0x07: "Disable Bill Acceptor",
    0x0E: "Enable/Disable Real Time Event Reporting",
    0x11: "Total Coin In Meter",
    0x1A: "Current Credit Meter",
    0x1B: "Handpay Information",
    0x1F: "Gaming Machine ID/Information (Denom)",
    0x54: "SAS Version ID & Serial Number",
    0x6F: "Legacy Meters",
    0x72: "AFT Initiate/Query Transfer",
    0x73: "AFT Register Gaming Machine",
    0x74: "AFT Game Lock and Status",
    0x7B: "Extended Validation Status",
    0xAF: "Extended Meters",
    0xA0: "Send Enabled Features",
    0xA4: "Send Cash Out Limit",
}

# ── Exception codes (General Poll responses) -- ported from exc_name() in sas_polling.cpp ──
EXCEPTION_NAMES = {
    0x00: "No activity",
    0x11: "Slot door OPENED",
    0x12: "Slot door CLOSED",
    0x17: "AC power applied",
    0x18: "AC power lost",
    0x1F: "No activity, waiting for player input (obsolete)",
    0x20: "General tilt",
    0x27: "Cashbox full detected",
    0x2E: "Cashbox near full detected",
    0x3C: "Operator changed options",
    0x3D: "Cash out ticket has been printed",
    0x3E: "Handpay has been validated",
    0x3F: "Validation ID not configured",
    0x44: "Reel 4 tilt",
    0x51: "Handpay pending",
    0x52: "Handpay was reset",
    0x57: "System validation request",
    0x66: "Cash out button pressed",
    0x67: "Ticket has been inserted",
    0x68: "Ticket transfer complete",
    0x69: "AFT transfer complete",
    0x6A: "AFT request for host cashout",
    0x6B: "AFT request for host to cash out win",
    0x6F: "Game locked",
    0x7C: "Legacy bonus pay awarded",
}

AFT_TRANSFER_CODES = {
    0x00: "FULL", 0x01: "PARTIAL", 0x80: "CANCEL",
    0xFE: "INTERROGATE", 0xFF: "INTERROGATE_ACK",
}
AFT_TRANSFER_TYPES = {
    0x00: "to machine", 0x10: "bonus coin-out to machine", 0x11: "bonus jackpot to machine",
    0x20: "to ticket", 0x40: "debit to machine", 0x60: "debit to ticket",
    0x80: "from machine (withdraw)", 0x90: "win to host",
}
AFT_REG_CODES = {0x00: "INIT", 0x01: "COMPLETE", 0x80: "UNREGISTER", 0xFF: "QUERY"}
AFT_LOCK_CODES = {0x00: "REQUEST", 0x80: "CANCEL", 0xFF: "INTERROGATE"}


def decode_frame(frame: bytes, direction: str) -> str:
    """Best-effort human-readable summary of one SAS frame.

    Only decodes fields for the shapes this project has directly verified
    against its own firmware/spec text (mostly host->machine REQUESTS,
    since that's what this tool is for) -- anything else falls back to
    just the command name plus raw hex, rather than guessing at an
    unverified offset.
    """
    if not frame:
        return "empty"

    if len(frame) == 1:
        addr = frame[0] & 0x7F
        if direction == "host":
            return f"General Poll -> addr=0x{addr:02X}"
        exc = frame[0]
        name = EXCEPTION_NAMES.get(exc, "Unknown")
        return f"Exception 0x{exc:02X} = {name}"

    addr = frame[0] & 0x7F
    cmd = frame[1]
    ok = "CRC_OK" if crc_ok(frame) else "CRC_FAIL"
    name = LP_NAMES.get(cmd, f"Unknown LP 0x{cmd:02X}")
    tag = f"addr=0x{addr:02X} {ok}  LP 0x{cmd:02X} \"{name}\""

    n = len(frame)

    # Bare Type-S commands: [addr][cmd][crc_l][crc_h], no data at all.
    if cmd in (0x01, 0x02, 0x06, 0x07) and n == 4:
        return tag

    # LP 0x0E Enable/Disable RTE Reporting: [addr][cmd][flag:0/1][crc_l][crc_h],
    # 5 bytes, no length byte (verified 2026-09-17 against SAS 6.02 Table 12.1).
    if cmd == 0x0E and n == 5:
        flag = frame[2]
        return tag + f" {'ENABLE' if flag else 'DISABLE'} RTE reporting (flag=0x{flag:02X})"

    # LP 0xA0/0xA4: request = [addr][cmd][game_number:2 BCD][crc_l][crc_h],
    # 6 bytes, no length byte (verified 2026-09-17 against SAS 6.02 Tables
    # 7.14a/7.16a). Response layouts (12 / 8 bytes respectively) are fixed-
    # size too but not decoded here yet -- this tool is for host requests.
    if cmd in (0xA0, 0xA4) and n == 6:
        game_number = bcd_to_int(frame[2:4])
        return tag + f" game_number={game_number} (request)"

    # LP 0x1A / 0x11: request = 4 bytes bare; response = 8 bytes with 4-byte BCD meter.
    if cmd in (0x1A, 0x11):
        if n == 4:
            return tag + " (request)"
        if n == 8:
            value = bcd_to_int(frame[2:6])
            return tag + f" (response) value={value}"
        return tag

    # LP 0x54 / 0x1F: request = 4 bytes bare, no data. Response layouts vary
    # by real hardware (e.g. a 24 vs 25-byte 0x1F seen on a real machine) --
    # not attempted here, shown as raw hex only.
    if cmd in (0x54, 0x1F) and n == 4:
        return tag + " (request)"

    # LP 0x1B Handpay: request = 4 bytes bare.
    if cmd == 0x1B and n == 4:
        return tag + " (request)"

    # LP 0x74 AFT Game Lock and Status: request is always exactly 8 bytes,
    # no length byte -- [addr][cmd][lock_code][transfer_condition][timeout:2 BCD][crc_l][crc_h].
    if cmd == 0x74 and n == 8:
        lock_code = frame[2]
        cond = frame[3]
        lock_name = AFT_LOCK_CODES.get(lock_code, f"0x{lock_code:02X}")
        return tag + f" lock_code={lock_name} transfer_condition=0x{cond:02X}"

    # LP 0x7B Extended Validation Status: request is always exactly 13 bytes.
    if cmd == 0x7B and n == 13:
        control_mask = le_to_int(frame[3:5])
        status_bits = le_to_int(frame[5:7])
        cashable_exp = bcd_to_int(frame[7:9])
        restricted_exp = bcd_to_int(frame[9:11])
        return tag + (f" control_mask=0x{control_mask:04X} status_bits=0x{status_bits:04X}"
                      f" cashable_exp_days={cashable_exp} restricted_exp_days={restricted_exp}")

    # LP 0x73 AFT Register: request >= 3 bytes to reach reg_code (frame[3]);
    # full register/unregister frames additionally carry a 4-byte LSB asset number.
    if cmd == 0x73 and n >= 4:
        reg_code = frame[3]
        reg_name = AFT_REG_CODES.get(reg_code, f"0x{reg_code:02X}")
        extra = ""
        if n >= 8:
            asset = le_to_int(frame[4:8])
            extra = f" asset_number={asset}"
        return tag + f" reg_code={reg_name}{extra}"

    # LP 0x72 AFT Transfer: request layout (fixed offsets regardless of the
    # variable-length txn_id field that follows -- see sas_commands.h):
    #   [addr][cmd][length][transfer_code][txn_index][transfer_type]
    #   [cashable:5 BCD][restricted:5 BCD][nonrestricted:5 BCD]...
    if cmd == 0x72 and n >= 23:
        transfer_code = frame[3]
        transfer_type = frame[5]
        cashable = bcd_to_int(frame[6:11])
        restricted = bcd_to_int(frame[11:16])
        nonrestricted = bcd_to_int(frame[16:21])
        amount = cashable or restricted or nonrestricted
        code_name = AFT_TRANSFER_CODES.get(transfer_code, f"0x{transfer_code:02X}")
        type_name = AFT_TRANSFER_TYPES.get(transfer_type, f"0x{transfer_type:02X}")
        return tag + f" transfer_code={code_name} type={type_name} amount_credits={amount}"

    # LP 0xAF Extended Meters: request = [addr][cmd][length][game_number:2 BCD]
    # {meter_code:2 binary LSB-first}...
    if cmd == 0xAF and n >= 7:
        game_number = bcd_to_int(frame[3:5])
        meter_names = {0x0000: "Coin In", 0x0001: "Coin Out", 0x0005: "Games Played"}
        codes = []
        i = 5
        while i + 1 < n - 2:  # stop before the 2 trailing CRC bytes
            code = le_to_int(frame[i:i + 2])
            codes.append(meter_names.get(code, f"0x{code:04X}"))
            i += 2
        return tag + f" game_number={game_number} meters=[{', '.join(codes)}]"

    return tag + f" (len={n}, not decoded further)"


# ── Selftest: verify the tables/offsets above without needing hardware ──
def _selftest() -> int:
    cases = [
        (bytes([0x81]), "host", "General Poll -> addr=0x01"),
        (bytes([0x11]), "machine", "Exception 0x11 = Slot door OPENED"),
        # 0x03, 0xA6 = the real CRC-16 of [0x01, 0x1A] (low byte first, then high byte).
        (bytes([0x01, 0x1A, 0x03, 0xA6]), "host",
         "addr=0x01 CRC_OK  LP 0x1A \"Current Credit Meter\" (request)"),
    ]
    failures = 0
    for frame, direction, expect in cases:
        got = decode_frame(frame, direction)
        if expect is not None and got != expect:
            print(f"[FAIL] decode_frame({frame!r}, {direction!r}) = {got!r}, expected {expect!r}")
            failures += 1
        else:
            print(f"[ ok ] {frame.hex(' ')}  ->  {got}")

    # CRC sanity check against a known-good vector.
    if crc16_sas(bytes([0x01, 0x1A])) != 0xA603:
        print("[FAIL] crc16_sas([0x01,0x1A]) != 0xA603")
        failures += 1
    else:
        print("[ ok ] crc16_sas([0x01,0x1A]) == 0xA603")

    # LP 0x72 AFT Transfer field decode, built by hand per sas_commands.h layout.
    aft = bytearray([0x01, 0x72, 0x00])
    aft += bytes([0x00, 0x00, 0x00])              # transfer_code=FULL, txn_index=0, type=to machine
    aft += bytes([0x00, 0x00, 0x01, 0x23, 0x45])   # cashable_amount BCD for 0000012345 = 12345
    aft += bytes([0x00] * 5)                       # restricted = 0
    aft += bytes([0x00] * 5)                       # nonrestricted = 0
    aft[2] = len(aft) - 3                          # length byte (excludes addr/cmd/length itself)
    crc = crc16_sas(bytes(aft))
    aft += bytes([crc & 0xFF, (crc >> 8) & 0xFF])
    got = decode_frame(bytes(aft), "host")
    if "transfer_code=FULL" not in got or "amount_credits=12345" not in got:
        print(f"[FAIL] AFT 0x72 decode: {got}")
        failures += 1
    else:
        print(f"[ ok ] {got}")

    # LP 0x0E RTE reporting disable, built by hand per SAS 6.02 Table 12.1.
    rte = bytearray([0x01, 0x0E, 0x00])
    crc = crc16_sas(bytes(rte))
    rte += bytes([crc & 0xFF, (crc >> 8) & 0xFF])
    got = decode_frame(bytes(rte), "host")
    if "DISABLE RTE reporting" not in got:
        print(f"[FAIL] LP 0x0E decode: {got}")
        failures += 1
    else:
        print(f"[ ok ] {got}")

    # LP 0xA0 Send Enabled Features request, game_number=0000, per Table 7.14a.
    a0 = bytearray([0x01, 0xA0, 0x00, 0x00])
    crc = crc16_sas(bytes(a0))
    a0 += bytes([crc & 0xFF, (crc >> 8) & 0xFF])
    got = decode_frame(bytes(a0), "host")
    if "game_number=0" not in got or "LP 0xA0" not in got:
        print(f"[FAIL] LP 0xA0 decode: {got}")
        failures += 1
    else:
        print(f"[ ok ] {got}")

    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", nargs="?", help="Serial port of the sniffing adapter, e.g. COM8")
    ap.add_argument("--baud", type=int, default=BAUD)
    ap.add_argument("--direction", choices=("host", "machine"), default="host",
                     help="Which side of the link you tapped. 'host' (default): the wire carrying "
                          "the SAS host's own TX (= the machine's RX) -- this is what you want to "
                          "see which commands the host sends. 'machine': the machine's own TX, to "
                          "read its responses/exceptions instead. Only affects how a 1-byte frame "
                          "is labeled (General Poll vs. Exception byte); Long Poll frames decode "
                          "the same either way.")
    ap.add_argument("--parity", choices=("none", "odd", "even", "mark", "space"), default="space",
                     help="Fixed UART parity to frame bytes with (default: space). A PC UART can't "
                          "read the real 9th bit like the ESP32 firmware does, so this only keeps "
                          "byte framing aligned -- it doesn't change which 8 data bits you see.")
    ap.add_argument("--selftest", action="store_true",
                     help="Run built-in decode checks against known sample frames and exit (no serial port needed).")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    if not args.port:
        ap.error("port is required unless --selftest is given")

    import serial  # imported lazily so --selftest works without pyserial installed

    parity_map = {
        "none": serial.PARITY_NONE, "odd": serial.PARITY_ODD, "even": serial.PARITY_EVEN,
        "mark": serial.PARITY_MARK, "space": serial.PARITY_SPACE,
    }
    ser = serial.Serial(
        port=args.port,
        baudrate=args.baud,
        bytesize=serial.EIGHTBITS,
        parity=parity_map[args.parity],
        stopbits=serial.STOPBITS_ONE,
        timeout=0.05,
    )
    print(f"[sas_command_reader] listening on {args.port} @ {args.baud} baud, "
          f"parity={args.parity}, direction={args.direction}")
    print("[sas_command_reader] Ctrl+C to stop\n")

    frame = bytearray()
    last_byte_time = None
    last_activity_time = time.monotonic()
    last_idle_warn = 0.0

    def flush():
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] {len(frame):3d}B  {frame.hex(' ')}   {decode_frame(bytes(frame), args.direction)}")
        frame.clear()

    try:
        while True:
            b = ser.read(1)
            now = time.monotonic()

            if b:
                if frame and last_byte_time is not None and (now - last_byte_time) > INTER_BYTE_TIMEOUT_S:
                    flush()
                frame += b
                last_byte_time = now
                last_activity_time = now
                last_idle_warn = now
            else:
                if frame and last_byte_time is not None and (now - last_byte_time) > INTER_BYTE_TIMEOUT_S:
                    flush()
                if now - last_activity_time > IDLE_WARN_S and now - last_idle_warn > IDLE_WARN_S:
                    ts = time.strftime("%H:%M:%S")
                    print(f"[{ts}] ... still silent, no bytes in {now - last_activity_time:.0f}s")
                    last_idle_warn = now
    except KeyboardInterrupt:
        print("\n[sas_command_reader] stopped")
    finally:
        ser.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
