import paho.mqtt.client as mqtt
import json, time, random
import urllib.request

def get_active_machines():
    try:
        url = "http://localhost:3000/api/tournaments"
        with urllib.request.urlopen(url, timeout=3) as r:
            data = json.loads(r.read())
            for t in data:
                if t.get("status") == "active":
                    ids = t.get("machine_ids", [])
                    print(f"Tournament: {t['name']} | Machines: {ids}")
                    return ids
    except Exception as e:
        print(f"Cannot fetch tournament: {e}")
    return []

MACHINES = get_active_machines()
if not MACHINES:
    print("No active tournament found. Using default IDs: 1,2,3")
    MACHINES = ["1", "2", "3"]

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.connect("localhost", 1883)

for mid in MACHINES:
    client.publish(f"casino/machine/{mid}/status", "online", retain=True)

print(f"Simulating {len(MACHINES)} machines. Ctrl+C to stop.\n")

coin_in = {mid: 0 for mid in MACHINES}

while True:
    for mid in MACHINES:
        speed = random.choices(
            [0, 1, 2, 3, 5, 8, 12],
            weights=[10, 20, 25, 20, 15, 7, 3]
        )[0]
        coin_in[mid] += speed

        client.publish(f"casino/machine/{mid}/telemetry", json.dumps({
            "credits": random.randint(5000, 15000),
            "coin_in": coin_in[mid],
            "coin_out": coin_in[mid] // 2,
            "state": 2,
            "exception": 0,
            "txn_id": "",
            "aft_status": 0
        }))

    scores = sorted(coin_in.items(), key=lambda x: -x[1])
    top = " | ".join(f"{m}:{s}" for m, s in scores[:3])
    print(f"Top3: {top}    ", end="\r")
    time.sleep(0.5)
