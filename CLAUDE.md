# CLAUDE.md – ESP32-Tourney

Hệ thống **Slot Tournament & Mystery Jackpot** thời gian thực, giao tiếp với máy slot qua giao thức SAS 6.0x.

---

## Kiến trúc tổng quan

```
Máy Slot (RS232 / SAS 6.0x)
      ↕ MAX3232 + 6N137 (cách ly galvanic)
Waveshare ESP32-S3-ETH  [ESP32-S3 LX7, 240MHz, 8MB Flash]
  ├─ Core 1: SAS Polling Task (40 ms, highest priority)
  ├─ Core 0: Network/MQTT Task
  └─ Any:    Watchdog Task
      ↕ W5500 Ethernet onboard (SPI2/FSPI, RJ45 tích hợp)
Mosquitto MQTT Broker (:1883)
      ↕
NestJS Backend (:3000)
  ├─ MqttGatewayService   — nhận telemetry, gửi lệnh
  ├─ TournamentService    — pump/withdraw credits, leaderboard
  ├─ JackpotService       — mystery jackpot PRNG engine
  ├─ PostgreSQL           — lịch sử giao dịch, tournament records
  └─ Redis                — digital twin, jackpot pool, sorted-set scores
      ↕ WebSocket
React Frontends
  ├─ control-panel (:5173) — admin dashboard
  └─ leaderboard   (:5174) — màn hình 4K real-time
```

---

## Trạng thái codebase

| Layer | Trạng thái | Ghi chú |
|---|---|---|
| Firmware (main, SAS, ETH, MQTT, Watchdog) | ✅ Hoàn chỉnh | Tất cả module có implementation thực sự |
| Backend entities, modules, gateway | ✅ Hoàn chỉnh | |
| Backend tournament.service.ts | ✅ Đã fix | Bug `private client` access → thay bằng `incrementScore()` |
| Backend machine controller | ✅ Đã thêm | `GET /api/machines` — frontend cần route này |
| Backend jackpot | ✅ Hoạt động | |
| Frontend control-panel (unified UI) | ✅ Redesigned | Split layout: LiveLeaderboard (left) + Sidebar tabs (right), casino dark-gold theme |
| Frontend leaderboard (:5174) | ✅ Hoàn chỉnh | Màn hình 4K độc lập, vẫn giữ nguyên |
| TypeORM migrations | ⚠️ Chưa có | Dev dùng `synchronize: true`, production cần tạo migrations |

---

## Cấu trúc thư mục

```
ESP32-Tourney/
├── firmware/
│   ├── platformio.ini          # board esp32-s3-devkitc-1, espressif32 ^6.6.0, Arduino Core v3.x
│   ├── include/config.h        # TẤT CẢ pin, baud, IP, topic MQTT → chỉnh tại đây
│   └── src/
│       ├── main.cpp            # Boot sequence + task spawn
│       ├── sas/                # SAS protocol layer
│       │   ├── sas_polling.h/cpp   # FreeRTOS task, state machine, 40ms cycle
│       │   ├── sas_commands.h/cpp  # AFT 72/74, lock/unlock, CRC-16 build
│       │   └── crc16.h/cpp         # CRC-16/ARC implementation
│       ├── network/
│       │   ├── eth_manager.h/cpp   # W5500 DHCP init, IP getter
│       │   └── mqtt_client.h/cpp   # PubSubClient wrapper, reconnect loop
│       └── watchdog/
│           └── watchdog_task.h/cpp # 2s hardware watchdog, NVS pending txn recovery
├── backend/
│   ├── .env.example            # Template biến môi trường
│   └── src/
│       ├── app.module.ts
│       ├── main.ts
│       ├── database/
│       │   ├── database.module.ts
│       │   ├── machine.controller.ts   # GET /api/machines
│       │   └── entities/
│       │       ├── machine.entity.ts       # MachineStatus enum, credits snapshot
│       │       ├── transaction.entity.ts   # TransactionType, TransactionStatus, aft_status_code
│       │       └── tournament.entity.ts    # TournamentStatus, machine_ids[], duration_seconds
│       ├── device-gateway/
│       │   ├── mqtt-gateway.service.ts # MQTT connect/subscribe/publish, telemetry router
│       │   └── leaderboard.gateway.ts  # Socket.IO gateway → broadcastLeaderboard/JackpotHit
│       ├── tournament/
│       │   ├── tournament.service.ts   # Phase 1 pump, Phase 2 score, Phase 3 end
│       │   └── tournament.controller.ts
│       ├── jackpot/
│       │   ├── jackpot.service.ts      # PRNG hit_value, coin-in contribution, AFT cashable
│       │   └── jackpot.controller.ts
│       └── redis/
│           └── redis.module.ts         # RedisService: machine state, jackpot pool, leaderboard + incrementScore()
├── frontend/
│   ├── control-panel/src/
│   │   ├── App.tsx                     # Split layout: leaderboard flex-1 left + 360px sidebar right
│   │   ├── index.css                   # Casino token system (dark gold palette, badges, buttons)
│   │   ├── components/
│   │   │   ├── LiveLeaderboard.tsx     # Socket.IO /leaderboard, score flash, top-3 medals, jackpot overlay
│   │   │   ├── TournamentManager.tsx   # Compact sidebar: active tourney, create form, history
│   │   │   └── DeviceDashboard.tsx     # Compact card grid: status-sorted, credits/coin stats
│   │   └── services/api.ts             # Axios client, unwraps .data — returns typed arrays directly
│   └── leaderboard/src/
│       ├── components/Leaderboard.tsx
│       └── hooks/useWebSocket.ts
├── sim_esp32.py                        # Competitive multi-machine simulator (auto-fetches active tourney IDs)
├── mosquitto/config/mosquitto.conf
├── docker-compose.yml
└── hardware/wiring_guide.txt
```

---

## MQTT Topics

| Topic | Hướng | Nội dung |
|---|---|---|
| `casino/machine/{id}/telemetry` | ESP32 → Backend | JSON: exception, credits, coin_in, coin_out, state, txn_id, aft_status |
| `casino/machine/{id}/events` | ESP32 → Backend | SAS exception events |
| `casino/machine/{id}/status` | ESP32 → Backend | `"online"` / `"offline"` (LWT) |
| `casino/machine/{id}/commands` | Backend → ESP32 | JSON: type (AFT_PUMP/AFT_WITHDRAW/LOCK/UNLOCK), amount, txn_id |

---

## Luồng nghiệp vụ chính

### Tournament (3 pha)
1. **Start** – `LOCK` → `AFT_PUMP` (restricted credits) → init Redis sorted-set score = 0
2. **Active** – mỗi coin-in event → `updateScore()` → `zincrby` trên Redis → WebSocket broadcast
3. **End** (tự động sau `duration_seconds`) – `AFT_WITHDRAW` → `UNLOCK` → status = FINISHED

### Mystery Jackpot
- Mỗi coin-in đóng góp `JACKPOT_CONTRIBUTION_RATE`% vào pool (Redis key)
- Khi `pool >= hit_value` (PRNG bí mật) → kích hoạt jackpot
- Gửi `AFT_PUMP` (cashable) đến máy thắng → broadcast jackpot hit → reset pool và sinh `hit_value` mới

### AFT Transaction Lifecycle
```
Backend gửi lệnh (txn_id uuid) → lưu DB status=PENDING
    ↓
ESP32 thực hiện AFT → trả telemetry có txn_id + aft_status
    ↓
Backend cập nhật DB status = SUCCESS | FAILED (aft_status_code)
```

---

## Ràng buộc quan trọng (KHÔNG vi phạm)

- **SAS polling ≤ 40 ms** – đây là yêu cầu cứng của SAS 6.0x. Task SAS chạy Core 1, priority cao nhất.
- **9-bit UART cho SAS** – byte địa chỉ dùng parity bit = 1 (address mark), byte dữ liệu parity = 0. ESP-IDF không native hỗ trợ → xem `sas_polling.cpp` để biết cách emulate.
- **NVS persistence** – watchdog khởi động lại phải recover `pending_txn_id` từ NVS trước khi tiếp tục poll. Không được mất transaction đang chờ.
- **TypeORM `synchronize: true` chỉ ở dev** – production dùng migrations. `app.module.ts` đã guard theo `NODE_ENV`.
- **Jackpot hit_value là bí mật** – không log ra ngoài. `generateNewHitValue()` chỉ in "set (internal)".

---

## Lệnh phát triển

### Backend
```bash
cd backend
cp .env.example .env     # lần đầu
npm install
npm run start:dev        # dev với hot-reload
npm run build            # production build
npm run migration:run    # chạy TypeORM migrations
```

### Frontend
```bash
# Control Panel
cd frontend/control-panel && npm install && npm run dev   # :5173

# Leaderboard
cd frontend/leaderboard && npm install && npm run dev     # :5174
```

### Docker (services)
```bash
docker-compose up -d postgres redis mosquitto   # chỉ services
docker-compose up -d                            # full stack
docker-compose logs -f backend                  # xem log
```

### Giả lập ESP32 (test frontend không cần phần cứng)

File `sim_esp32.py` ở root — tự động fetch machine IDs từ tournament đang active:

```bash
pip install paho-mqtt
python sim_esp32.py
```

Simulator:
- Gọi `GET /api/tournaments` → tìm tournament status=active → lấy `machine_ids[]`
- Publish telemetry cho tất cả machine với tốc độ coin_in ngẫu nhiên (weighted: chậm thắng nhanh)
- Nếu không có active tournament: fallback dùng IDs ["1","2","3"]
- Dừng: Ctrl+C

### Firmware (PlatformIO CLI hoặc VS Code)
```bash
cd firmware
pio run                              # build
pio run --target upload              # build + flash (USB CDC)
pio device monitor                   # serial monitor 115200 baud
pio run --target clean               # clean build
pio run -e esp32s3-eth               # build env cụ thể
```
> ESP32-S3-ETH upload qua USB CDC mặc định. Nếu dùng USB-UART adapter ngoài, thêm `upload_protocol = esptool` trong `platformio.ini`.

---

## UI Control Panel — Thiết kế thống nhất

Control panel (:5173) đã được redesign thành **một trang duy nhất**, gộp leaderboard và dashboard:

```
┌─────────────────────────────┬──────────────────────┐
│  LEADERBOARD (flex: 1)      │  SIDEBAR (360px)      │
│                             │  ┌─ Tournament tab ──┐ │
│  GMI TOURNAMENT        LIVE │  │ Active tourney    │ │
│  ──────────────────────     │  │ Create form       │ │
│  ① Machine-A    12,840 pts  │  │ History list      │ │
│  ② Machine-B     9,210 pts  │  └───────────────────┘ │
│  #3 Machine-C    7,500 pts  │  ┌─ Devices tab ────┐ │
│  ...                        │  │ Status-sorted     │ │
│                             │  │ card grid         │ │
│  [JACKPOT OVERLAY]          │  └───────────────────┘ │
└─────────────────────────────┴──────────────────────┘
```

**Design tokens** (index.css):
- Background: `#07080d`, Surface: `#0e1018 / #161921`
- Gold: `#c8a84b`, Text: `#ede8d8`
- Score/rank typography: Georgia serif + `tabular-nums`

**Luồng dữ liệu UI:**
- `LiveLeaderboard` → Socket.IO `/leaderboard` namespace → event `leaderboard_update`
- `DeviceDashboard` → polling `GET /api/machines` mỗi 4 giây
- `TournamentManager` → REST API (create/start/end)

---

## Lưu ý triển khai

### Docker PostgreSQL port
`docker-compose.yml` map port `5433:5432` (không phải 5432) để tránh xung đột nếu có PostgreSQL khác đang chạy trên host. File `.env` phải có `DB_PORT=5433`.

### Mosquitto (dev)
`mosquitto.conf` hiện dùng `allow_anonymous true` cho môi trường dev. Production cần tạo password file và đổi lại `allow_anonymous false`.

---

## Biến môi trường Backend

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DB_HOST/PORT/NAME/USER/PASS` | localhost/5432/esp32_tourney/... | PostgreSQL |
| `REDIS_HOST/PORT` | localhost/6379 | Redis |
| `MQTT_HOST/PORT/USER/PASS` | localhost/1883/esp32/changeme | Mosquitto |
| `PORT` | 3000 | NestJS HTTP port |
| `NODE_ENV` | development | `production` tắt TypeORM sync |
| `JACKPOT_CONTRIBUTION_RATE` | 0.5 | % coin-in vào jackpot pool |
| `JACKPOT_BASE_AMOUNT` | 10000 | Credits pool reset về đây sau jackpot |
| `JACKPOT_MAX_AMOUNT` | 1000000 | Giới hạn trên của hit_value |

---

## Cấu hình Firmware (config.h)

**Pin W5500 (cố định trên PCB, KHÔNG chỉnh):** MOSI=11, MISO=12, SCLK=13, CS=14, RST=9, INT=10

Chỉ thay đổi những define sau trước khi flash cho từng máy vật lý:

| Define | Giá trị mặc định | Ghi chú |
|---|---|---|
| `SAS_MACHINE_ADDRESS` | `0x01` | Địa chỉ SAS (1–127), mỗi máy khác nhau |
| `MQTT_BROKER_HOST` | `"192.168.1.100"` | IP của server chạy Mosquitto |
| `MQTT_CLIENT_ID` | `"GMI-Machine-01"` | Phải unique trên toàn broker |
| `MQTT_TOPIC_*` | `casino/machine/01/...` | Phải khớp với machine ID |
| `ETH_RST_PIN` | `9` | Onboard RST — giữ nguyên, trace PCB cố định |

---

## Database Entities

- **MachineEntity** – snapshot real-time: `machine_id`, `credits`, `coin_in`, `coin_out`, `status` (ONLINE/OFFLINE/PLAYING/LOCKED/HANDPAY)
- **TransactionEntity** – immutable audit log: `txn_id` (uuid), `type` (TOURNAMENT_PUMP/TOURNAMENT_WITHDRAW/JACKPOT_CASHABLE), `status` (PENDING/SUCCESS/FAILED), `aft_status_code`, `amount`, `tournament_id`
- **TournamentEntity** – `machine_ids[]`, `initial_credits`, `duration_seconds`, `status` (SCHEDULED/ACTIVE/FINISHED)

---

## Redis Keys

| Key | Kiểu | Nội dung |
|---|---|---|
| `machine:{id}:state` | Hash | credits, coin_in, coin_out, state, updated_at |
| `tourney:{id}:scores` | Sorted Set | member=machineId, score=tổng coin-in trong tournament |
| `jackpot:pool` | String | Giá trị pool hiện tại (float) |
| `jackpot:hit_value` | String | Hit value bí mật (int) |

---

## Hardware

**MCU:** Waveshare ESP32-S3-ETH
- Chip: ESP32-S3 (Xtensa LX7 dual-core 240 MHz), flash 8 MB Octal
- Ethernet: **W5500 onboard** (traces PCB cố định, KHÔNG thay đổi pin)
- Không cần module W5500 rời — board đã tích hợp sẵn + RJ45

| Linh kiện | Chân / Ghi chú |
|---|---|
| **W5500 (onboard)** | SPI2/FSPI: MOSI=**11**, MISO=**12**, SCLK=**13**, CS=**14**, RST=**9**, INT=**10** — traces cố định trên PCB, không đấu dây thêm |
| **GPIO cấm dùng** | 9–14 (W5500) · 33–37 (Octal Flash/PSRAM) · 19–20 (USB CDC) · 43–44 (UART0 debug) · 4–7 (SD Card nếu có) |
| **SAS UART2** | TX=**GPIO17** (header trái pin 34) · RX=**GPIO16** (header trái pin 32) — xác nhận FREE trên pinout chính thức |
| MAX3232 | Chuyển RS232 ±12V ↔ TTL 5V; nối với GPIO17/16 qua 6N137; 4 tụ 1µF charge pump bắt buộc |
| 6N137 Optocoupler ×2 | Cách ly quang giữa Domain A (ESP32 3.3V) và Domain B (MAX3232 5V isolated) |
| **Mornsun B0505S-1W #1** | Cấp nguồn isolated cho **Domain B** (MAX3232 + phototransistor side 6N137) |
| **Mornsun B0505S-1W #2** | Cấp nguồn isolated cho **Domain A** (ESP32 VSYS) |

### Kiến trúc nguồn (2x B0505S, nguồn duy nhất từ máy slot)

```
Máy slot 5V ─────┬──────────────────────────────────
Máy slot GND ────┘
                 │
         ┌───────┴───────┐
         │               │
    [B0505S #1]      [B0505S #2]
    Domain B         Domain A
    GND_B (isolated) GND_A (isolated)
    MAX3232 + 6N137B ESP32 VSYS
         │               │
         └────[6N137]────┘
           cách ly quang
```

- **GND_A, GND_B, GND máy slot** — ba ground hoàn toàn độc lập, không điểm chung
- Toàn bộ thiết bị tự cấp nguồn từ máy slot, không cần AC adapter ngoài
- **Không dùng USB từ backplane máy slot** để cấp cho ESP32 — sẽ phá vỡ cách ly

Xem chi tiết sơ đồ nối dây: `hardware/wiring_guide.txt`
