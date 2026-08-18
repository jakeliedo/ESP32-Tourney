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
| Backend tournament (multi-round + history) | ✅ Hoàn chỉnh | `session_id`, `session_name`, `round_number`, `total_rounds`; cancel/end tách biệt |
| Backend player management | ✅ Hoàn chỉnh | `PlayerEntity`, `PlayerModule`, CRUD `/api/players` |
| Backend round results | ✅ Hoàn chỉnh | `RoundResultEntity` — chỉ lưu khi timer hết tự nhiên (không lưu khi STOP thủ công) |
| Backend machine controller | ✅ Hoàn chỉnh | `GET /api/machines` + PATCH, commands |
| Backend jackpot | ✅ Hoạt động | |
| Scoring logic | ✅ Credits-based | Score = credits hiện tại của máy (không phải coin_in delta) |
| Frontend control-panel | ✅ Hoàn chỉnh | Tabbed panel: Machines / History / Players; multi-round session; session naming |
| Frontend leaderboard (:5174) | ✅ Hoàn chỉnh | Xóa máy offline khỏi bảng; bảng trống khi không có máy kết nối |
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
│       │   ├── sas_polling.h/cpp   # FreeRTOS task, state machine, 40ms cycle; CMD_DISABLE/ENABLE dispatch
│       │   ├── sas_commands.h/cpp  # AFT 0x72/0x74; LP simple: 0x01 Shutdown, 0x02 Startup, 0x06/0x07 Bill
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
│       │   ├── machine.controller.ts   # GET /api/machines, PATCH, commands
│       │   └── entities/
│       │       ├── machine.entity.ts       # MachineStatus enum, credits snapshot
│       │       ├── transaction.entity.ts   # TransactionType, TransactionStatus, aft_status_code
│       │       ├── tournament.entity.ts    # TournamentStatus (SCHEDULED/ACTIVE/FINISHED/CANCELLED) + session_id/name
│       │       ├── player.entity.ts        # membership_number (PK), display_name
│       │       └── round_result.entity.ts  # standings snapshot per round (rank, score, advanced)
│       ├── device-gateway/
│       │   ├── mqtt-gateway.service.ts # MQTT connect/subscribe/publish, telemetry router; ZREM khi máy offline
│       │   └── leaderboard.gateway.ts  # broadcastLeaderboard(id, rankings, roundNumber, totalRounds, endsAt)
│       ├── tournament/
│       │   ├── tournament.service.ts   # end()/cancel() atomic flip; getHistory() → SessionDto[]
│       │   └── tournament.controller.ts  # POST /:id/cancel (mới)
│       ├── player/
│       │   ├── player.module.ts
│       │   └── player.controller.ts    # CRUD /api/players (upsert by membership_number)
│       ├── jackpot/
│       │   ├── jackpot.service.ts      # PRNG hit_value, coin-in contribution, AFT cashable
│       │   └── jackpot.controller.ts
│       └── redis/
│           └── redis.module.ts         # RedisService: machine state, jackpot pool, leaderboard + removeFromLeaderboard()
├── frontend/
│   ├── control-panel/src/
│   │   ├── App.tsx                     # All-in-one: Machines/History/Players; session naming; cancel vs end flow
│   │   ├── index.css                   # Casino token system; spinners ẩn toàn cục, chỉ bật cho rounds input
│   │   ├── components/
│   │   │   ├── LiveLeaderboard.tsx     # (unused — logic in App.tsx)
│   │   │   ├── TournamentManager.tsx   # (unused — logic in App.tsx)
│   │   │   └── DeviceDashboard.tsx     # (unused — logic in App.tsx)
│   │   └── services/api.ts             # Axios; Tournament/SessionDto/RoundDto types; cancelTournament()
│   └── leaderboard/src/
│       ├── components/Leaderboard.tsx  # tournamentRunning logic; sourceRows; ZREM offline machines
│       └── hooks/useWebSocket.ts       # transports: websocket + polling fallback
├── sim_esp32.py                        # Simulator: chỉ trừ credits khi tournament ACTIVE
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
| `casino/machine/{id}/commands` | Backend → ESP32 | JSON: type (AFT_PUMP/AFT_WITHDRAW/LOCK/UNLOCK/DISABLE/ENABLE), amount, txn_id |

---

## Luồng nghiệp vụ chính

### Tournament (3 pha)
1. **Start** – nhấn **START TOURNAMENT** → tự động ENABLE tất cả máy không offline → init Redis sorted-set score = credits hiện tại từ DB → broadcast leaderboard
2. **Active** – mỗi khi credits thay đổi (telemetry) → `updateScore()` → `zadd` trên Redis → WebSocket broadcast kèm `roundNumber`/`totalRounds`
3. **End — hai trường hợp:**
   - **Timer hết tự nhiên** → `end()` → DISABLE tất cả máy → lưu `RoundResultEntity` → broadcast final → `roundsCompleted++` → vào History
   - **STOP thủ công** → `cancel()` → DISABLE tất cả máy → **không** lưu kết quả → **không** tính round → session giữ nguyên, user retry cùng round

### Vòng đời Tournament status
```
SCHEDULED → ACTIVE → FINISHED   (timer hết, lưu kết quả)
                   → CANCELLED  (STOP thủ công, không lưu)
```
- `getHistory()` chỉ trả về FINISHED. CANCELLED không xuất hiện trong History.
- `end()` và `cancel()` đều dùng atomic `UPDATE WHERE status=ACTIVE` để tránh race condition giữa timer server-side và lệnh STOP.

### Multi-Round Session
- Mỗi round = một `TournamentEntity` riêng, liên kết qua `session_id` (UUID tạo client-side)
- `session_name` được đặt khi bắt đầu round 1, copy sang các round tiếp; input bị disabled khi session đang chạy
- Sau khi round kết thúc tự nhiên: nếu `roundsCompleted < totalRounds` → hiện nút **START ROUND N** + **NEW SESSION**
- Sau khi STOP thủ công: session giữ nguyên, nút START hiện lại cùng số round để retry
- Score display: `$XX.XX` = credits / 100 (credits lưu DB là integer, e.g. 10000 = $100.00)

### Mystery Jackpot
- Mỗi coin-in đóng góp `JACKPOT_CONTRIBUTION_RATE`% vào pool (Redis key)
- Khi `pool >= hit_value` (PRNG bí mật) → kích hoạt jackpot
- Gửi `AFT_PUMP` (cashable) đến máy thắng → broadcast jackpot hit → reset pool và sinh `hit_value` mới

### Leaderboard — hành vi offline
- Khi máy mất kết nối → backend gọi `ZREM` trên Redis sorted-set → broadcast lại leaderboard không có máy đó
- Nếu không có máy nào kết nối → `sourceRows = []` → bảng trống hoàn toàn
- `tournamentRunning` (không phải `isInTournament`) kiểm soát toàn bộ display logic

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
- **DISABLE ≠ LOCK** – LOCK = LP 0x01 Shutdown (tournament, cho cashout); DISABLE = LP 0x01 + delay 40ms + LP 0x07 Disable Bill (admin, chặn hoàn toàn). Firmware dispatch theo `CMD_DISABLE=4` / `CMD_ENABLE=5`, tách biệt `CMD_LOCK=2` / `CMD_UNLOCK=3`.
- **NVS persistence** – watchdog khởi động lại phải recover `pending_txn_id` từ NVS trước khi tiếp tục poll. Không được mất transaction đang chờ.
- **TypeORM `synchronize: true` chỉ ở dev** – production dùng migrations. `app.module.ts` đã guard theo `NODE_ENV`.
- **Jackpot hit_value là bí mật** – không log ra ngoài. `generateNewHitValue()` chỉ in "set (internal)".
- **`end()` / `cancel()` atomic** – dùng `UPDATE WHERE status=ACTIVE`; nếu `affected=0` thì return ngay. Không bao giờ lưu `RoundResultEntity` hai lần.

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
- **Chỉ trừ credits khi tournament ACTIVE** — ENABLE đơn thuần không kích hoạt trừ credits
- Nếu không có active tournament: fallback dùng IDs ["MC01","MC02","MC03"]
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

Control panel (:5173) là **một trang duy nhất** (`App.tsx`), layout dọc:

```
┌─────────────────────────────────────────────────────┐
│  Header: ◈ SLOT TOURNAMENT                  v1.0.0  │
├─────────────────────────────────────────────────────┤
│  Initial Settings (4 cột + Session Name full-width) │
│    Start Credit | Time MM:SS | Rounds | JP Initial  │
│    Session Name: ________________________           │
├─────────────────────────────────────────────────────┤
│  Controls:                                          │
│    [Refresh] [Enable All] [Disable All] [AFT IN/OUT]│
│    SESSION: Round 2/3  [FINAL ROUND]                │
│    [▶ START ROUND 2]  [NEW SESSION]                 │
│    TIME LEFT  04:32              [STOP]             │
├─────────────────────────────────────────────────────┤
│  Tabbed Panel:  [Machines (3)] [History] [Players]  │
│  ─ Machines: 1 dòng/máy: ID · Name · IP · Status   │
│              · $XX.XX · ENABLED/DISABLED · [BUY-IN] │
│  ─ History: grid 4 cột, tối đa 8 thẻ gần nhất      │
│             Mỗi thẻ: tên session (màu theo session) │
│             Round x/y · D/M · H:M:S                │
│             🥇🥈🥉 rankings                         │
│  ─ Players: membership# + display_name, CRUD        │
├─────────────────────────────────────────────────────┤
│  Footer: version | LB status | machines | round N/∞ │
└─────────────────────────────────────────────────────┘
```

**Design tokens** (index.css):
- Background: `#07080d`, Surface: `#0e1018 / #161921`
- Gold: `#c8a84b`, Text: `#ede8d8`
- Number spinners: ẩn toàn cục, chỉ hiện cho rounds input (`.with-spin`)
- Score/rank typography: Georgia serif + `tabular-nums`

**History tab — chi tiết:**
- 8 round cards gần nhất (sort theo `endedAt` DESC, flatten qua tất cả sessions)
- Grid 4 cột, mỗi thẻ `alignSelf: start` (không kéo cao bằng nhau)
- Màu thẻ: hash `session_id` → index vào `SESSION_COLORS[10]` — deterministic, reload vẫn cùng màu
- Header 2 dòng: (1) tên session màu accent, (2) `Round N/M · D/M · HH:mm:ss`
- Ranks: 🥇🥈🥉 cho top 3, `#N` text màu `var(--text-3)` cho phần còn lại
- Chỉ xuất hiện khi round kết thúc **tự nhiên** (timer hết); STOP thủ công không tạo thẻ

**Luồng dữ liệu UI:**
- Machine list → polling `GET /api/machines` mỗi 2 giây; `enabledSet` sync từ DB status (offline/disabled → remove)
- START TOURNAMENT → auto-enable tất cả máy không offline, không cần bấm Enable All trước
- Tournament → REST API (create/start/end/cancel)
- History tab → `GET /api/tournaments/history` trả `SessionDto[]`, mở tab thì load
- Players tab → `GET /api/players`, POST upsert, DELETE xóa

**Leaderboard (:5174) — hành vi:**
- `tournamentRunning=true` → hiện rankings từ Redis
- `tournamentRunning=false` + có máy → hiện credits thực tế (pre-tourney view)
- Không có máy kết nối → bảng trống hoàn toàn (kể cả khi có stale data trong state)
- Máy offline trong lúc tournament → bị ZREM khỏi leaderboard ngay lập tức

---

## API Endpoints (Backend :3000)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/machines` | Danh sách máy |
| PATCH | `/api/machines/:id` | Cập nhật display_name |
| POST | `/api/machines/:id/command` | Gửi lệnh (ENABLE/DISABLE/AFT_PUMP...) |
| POST | `/api/machines/aft-in-all` | AFT IN tất cả máy enabled |
| POST | `/api/machines/aft-out-all` | AFT OUT tất cả máy |
| GET | `/api/tournaments` | Tất cả tournaments |
| GET | `/api/tournaments/history` | 8 rounds FINISHED gần nhất, nhóm theo session (`SessionDto[]`) |
| GET | `/api/tournaments/:id` | Chi tiết tournament |
| POST | `/api/tournaments` | Tạo tournament (kèm `session_id`, `session_name`, `round_number`, `total_rounds`) |
| POST | `/api/tournaments/:id/start` | Bắt đầu (ENABLE + init Redis scores) |
| POST | `/api/tournaments/:id/end` | Kết thúc tự nhiên (DISABLE + lưu RoundResult + broadcast final) |
| POST | `/api/tournaments/:id/cancel` | Huỷ thủ công (DISABLE + **không** lưu kết quả, status=CANCELLED) |
| POST | `/api/tournaments/:id/next-round` | Tạo tournament mới kế tiếp trong cùng session |
| GET | `/api/players` | Danh sách players |
| GET | `/api/players/:id` | Tìm theo membership_number |
| POST | `/api/players` | Upsert player (membership_number + display_name) |
| PATCH | `/api/players/:id` | Cập nhật display_name |
| DELETE | `/api/players/:id` | Xóa player |
| GET | `/api/jackpot/pool` | Jackpot pool hiện tại |

---

## WebSocket Events (Socket.IO namespace `/leaderboard`)

| Event | Hướng | Payload |
|---|---|---|
| `leaderboard_update` | Server → Client | `{ tournamentId, rankings[], roundNumber, totalRounds, endsAt }` — `endsAt`: epoch ms nếu đang chạy, `0` nếu kết thúc, `-1` noop |
| `jackpot_hit` | Server → Client | `{ machineId, amount }` |
| `machine_update` | Server → Client | `{ machineId, credits, coin_in, coin_out, status }` |

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

- **MachineEntity** – snapshot real-time: `machine_id`, `display_name`, `credits`, `coin_in`, `coin_out`, `status` (ONLINE/OFFLINE/PLAYING/LOCKED/HANDPAY/DISABLED)
- **TransactionEntity** – immutable audit log: `txn_id` (uuid), `type` (TOURNAMENT_PUMP/TOURNAMENT_WITHDRAW/JACKPOT_CASHABLE), `status` (PENDING/SUCCESS/FAILED), `aft_status_code`, `amount`, `tournament_id`
- **TournamentEntity** – `machine_ids[]`, `initial_credits`, `duration_seconds`, `status` (**SCHEDULED/ACTIVE/FINISHED/CANCELLED**), `session_id` (varchar 36), `session_name` (varchar 100, nullable), `round_number` (int, default 1), `total_rounds` (int, default 1)
- **PlayerEntity** – `membership_number` (PK varchar 30), `display_name` (varchar 100)
- **RoundResultEntity** – snapshot cuối round: `tournament_id`, `machine_id`, `player_display` (snapshot display_name), `final_score`, `rank`, `advanced` (bool), `session_id`, `round_number`, `total_rounds`

**Lưu ý credits:** lưu dạng integer (10000 = $100.00). Mọi chỗ hiển thị phải ÷100 để ra $XX.XX.

**Lưu ý CANCELLED:** Tournament bị STOP thủ công có status=CANCELLED. Không có `RoundResultEntity` tương ứng. `getHistory()` filter `WHERE status=FINISHED`, nên CANCELLED không xuất hiện.

---

## Redis Keys

| Key | Kiểu | Nội dung |
|---|---|---|
| `machine:{id}:state` | Hash | credits, coin_in, coin_out, state, updated_at |
| `tourney:{id}:scores` | Sorted Set | member=machineId, score=credits hiện tại; ZREM khi máy offline |
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
