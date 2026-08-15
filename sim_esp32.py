"""
ESP32 Slot Machine Simulator
- Subscribes to MQTT command topics and reacts to AFT_PUMP / AFT_WITHDRAW / LOCK / UNLOCK
- Publishes offline status for clean disconnect on Ctrl+C
- Auto-fetches machine IDs from active tournament; falls back to defaults
"""
import paho.mqtt.client as mqtt
import json, time, random, signal, sys, urllib.request

BROKER = "localhost"
BROKER_PORT = 1883
DEFAULT_MACHINES = ["MC01", "MC02", "MC03"]

# ── Fetch active tournament machines ─────────────────────────
def get_active_machines():
    try:
        with urllib.request.urlopen("http://localhost:3000/api/tournaments", timeout=3) as r:
            for t in json.loads(r.read()):
                if t.get("status") == "active" and t.get("machine_ids"):
                    print(f"[SIM] Tournament: {t['name']} | Machines: {t['machine_ids']}")
                    return t["machine_ids"]
    except Exception as e:
        print(f"[SIM] Cannot fetch tournament ({e}), using defaults")
    return []

MACHINES = get_active_machines() or DEFAULT_MACHINES

# ── Per-machine state ─────────────────────────────────────────
state = {mid: {"coin_in": 0, "credits": 0, "locked": False} for mid in MACHINES}

# ── MQTT callbacks ────────────────────────────────────────────
def on_connect(client, userdata, flags, rc, props=None):
    if rc == 0:
        for mid in MACHINES:
            client.subscribe(f"casino/machine/{mid}/commands")
        print(f"[SIM] Connected to broker — subscribed to {len(MACHINES)} command channels")
    else:
        print(f"[SIM] Broker connect failed, rc={rc}")

def on_message(client, userdata, msg):
    try:
        parts = msg.topic.split('/')
        if len(parts) < 4 or parts[3] != 'commands':
            return
        mid = parts[2]
        if mid not in state:
            state[mid] = {"coin_in": 0, "credits": 0, "locked": False}

        payload = json.loads(msg.payload)
        cmd = payload.get('type', '')
        amount = int(payload.get('amount', 0))

        if cmd == 'AFT_PUMP':
            state[mid]['credits'] += amount
            print(f"\n[CMD] AFT_PUMP  {mid:6s} +{amount:>8d} → credits={state[mid]['credits']}")
        elif cmd == 'AFT_WITHDRAW':
            state[mid]['credits'] = 0
            print(f"\n[CMD] AFT_OUT   {mid:6s} → credits=0")
        elif cmd == 'LOCK':
            state[mid]['locked'] = True
            print(f"\n[CMD] LOCK      {mid}")
        elif cmd == 'UNLOCK':
            state[mid]['locked'] = False
            print(f"\n[CMD] UNLOCK    {mid}")
    except Exception as e:
        print(f"\n[CMD] Parse error: {e}")

# ── Clean shutdown ────────────────────────────────────────────
def on_exit(sig, frame):
    print("\n[SIM] Shutting down — publishing offline status...")
    for mid in MACHINES:
        client.publish(f"casino/machine/{mid}/status", "offline", retain=True)
    time.sleep(0.5)
    client.loop_stop()
    client.disconnect()
    sys.exit(0)

signal.signal(signal.SIGINT,  on_exit)
signal.signal(signal.SIGTERM, on_exit)

# ── MQTT setup ────────────────────────────────────────────────
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.on_connect = on_connect
client.on_message = on_message
client.connect(BROKER, BROKER_PORT)
client.loop_start()

# Announce online
for mid in MACHINES:
    client.publish(f"casino/machine/{mid}/status", "online", retain=True)

print(f"[SIM] Simulating {len(MACHINES)} machines: {MACHINES}")
print("[SIM] Ctrl+C to stop\n")

# ── Main loop ─────────────────────────────────────────────────
while True:
    for mid in MACHINES:
        if not state[mid]['locked']:
            speed = random.choices(
                [0, 1, 2, 3, 5, 8, 12],
                weights=[10, 20, 25, 20, 15, 7, 3]
            )[0]
            state[mid]['coin_in'] += speed

        client.publish(f"casino/machine/{mid}/telemetry", json.dumps({
            "credits": state[mid]['credits'],
            "coin_in":  state[mid]['coin_in'],
            "coin_out": state[mid]['coin_in'] // 2,
            "state": 2,
            "exception": 0,
            "txn_id": "",
            "aft_status": 0
        }))

    top = sorted(state.items(), key=lambda x: -x[1]['credits'])
    line = "  ".join(f"{m}:${v['credits']//100:.0f}" for m, v in top[:4])
    print(f"Credits: {line}    ", end="\r")
    time.sleep(0.5)
