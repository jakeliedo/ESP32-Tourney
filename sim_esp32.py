"""
ESP32 Slot Machine Simulator
- Subscribes to MQTT command topics and reacts to AFT_PUMP / AFT_WITHDRAW / LOCK / UNLOCK / DISABLE / ENABLE
- Publishes offline status for clean disconnect on Ctrl+C
- Auto-fetches machine IDs from active tournament; falls back to defaults
- Credits are only deducted while a tournament is ACTIVE (not just enabled)
"""
import paho.mqtt.client as mqtt
import json, time, random, signal, sys, urllib.request, threading

BROKER = "localhost"
BROKER_PORT = 1883
DEFAULT_MACHINES = ["MC01", "MC02", "MC03", "MC04", "MC05", "MC06", "MC07", "MC08", "MC09", "MC10"]

# ── Tournament active flag (polled every 2s) ──────────────────
tournament_active = False

def poll_tournament_status():
    global tournament_active
    while True:
        try:
            with urllib.request.urlopen("http://localhost:3000/api/tournaments", timeout=3) as r:
                active = any(t.get("status") == "active" for t in json.loads(r.read()))
                if active != tournament_active:
                    tournament_active = active
                    print(f"\n[SIM] Tournament {'STARTED — machines now playing' if active else 'ENDED — machines idle'}")
        except Exception:
            pass
        time.sleep(2)

# ── Fetch active tournament machines ─────────────────────────
# Returns union of tournament machines + DEFAULT_MACHINES so all 10
# virtual slots always run, regardless of how many are in the tournament.
def get_active_machines():
    tourney_ids = []
    try:
        with urllib.request.urlopen("http://localhost:3000/api/tournaments", timeout=3) as r:
            for t in json.loads(r.read()):
                if t.get("status") == "active" and t.get("machine_ids"):
                    tourney_ids = t["machine_ids"]
                    print(f"[SIM] Tournament machines: {tourney_ids}")
                    break
    except Exception as e:
        print(f"[SIM] Cannot fetch tournament ({e}), using defaults only")

    # Merge: tournament machines first, then defaults
    merged = list(tourney_ids)
    for mid in DEFAULT_MACHINES:
        if mid not in merged:
            merged.append(mid)
    return merged

MACHINES = get_active_machines()

# ── Per-machine state ─────────────────────────────────────────
state = {mid: {"coin_in": 0, "credits": 0, "locked": True, "disabled": True} for mid in MACHINES}

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
            state[mid] = {"coin_in": 0, "credits": 0, "locked": False, "disabled": False}

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
        elif cmd == 'DISABLE':
            state[mid]['disabled'] = True
            state[mid]['locked'] = True
            print(f"\n[CMD] DISABLE   {mid}  (LP 0x01 + LP 0x07)")
        elif cmd == 'ENABLE':
            state[mid]['disabled'] = False
            state[mid]['locked'] = False
            print(f"\n[CMD] ENABLE    {mid}  (LP 0x02 + LP 0x06)")
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
print("[SIM] Credits only deduct when a tournament is ACTIVE")
print("[SIM] Ctrl+C to stop\n")

# Start background tournament poller
threading.Thread(target=poll_tournament_status, daemon=True).start()

# ── Main loop ─────────────────────────────────────────────────
while True:
    for mid in MACHINES:
        # Only simulate betting when tournament is active AND machine is not locked/disabled
        if tournament_active and not state[mid]['locked'] and not state[mid]['disabled']:
            speed = random.choices(
                [0, 1, 2, 3, 5, 8, 12],
                weights=[10, 20, 25, 20, 15, 7, 3]
            )[0]
            bet = min(speed, state[mid]['credits'])
            state[mid]['credits'] -= bet
            state[mid]['coin_in'] += bet

        # state: 6=disabled, 3=locked(tournament), 2=playing, 1=idle/enabled
        if state[mid]['disabled']:
            sim_state = 6
        elif state[mid]['locked']:
            sim_state = 3
        elif tournament_active:
            sim_state = 2  # actively playing
        else:
            sim_state = 1  # enabled but no active tournament

        client.publish(f"casino/machine/{mid}/telemetry", json.dumps({
            "credits": state[mid]['credits'],
            "coin_in":  state[mid]['coin_in'],
            "coin_out": state[mid]['coin_in'] // 2,
            "state": sim_state,
            "exception": 0,
            "txn_id": "",
            "aft_status": 0
        }))

    top = sorted(state.items(), key=lambda x: -x[1]['credits'])
    line = "  ".join(f"{m}:${v['credits']//100:.0f}" for m, v in top[:4])
    status = "ACTIVE" if tournament_active else "idle"
    print(f"[{status}] Credits: {line}    ", end="\r")
    time.sleep(0.5)
