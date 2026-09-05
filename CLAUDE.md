# CLAUDE.md – ESP32-Tourney (nhánh EVO)

> **Nhánh này** dùng board **WT32-ETH01-Evo** (ESP32-C3) thay cho Waveshare ESP32-S3-ETH của nhánh `main`.
> Xem sự khác biệt kiến trúc tại mục [So sánh với nhánh main](#so-sánh-với-nhánh-main).

Hệ thống **Slot Tournament & Mystery Jackpot** thời gian thực, giao tiếp với máy slot qua giao thức SAS 6.0x.

---

## Kiến trúc tổng quan

```
Máy Slot (RS232 / SAS 6.0x)
      ↕ MAX3232 + 6N137 (cách ly galvanic)
WT32-ETH01-Evo  [ESP32-C3 RISC-V, 160MHz, single-core, 4MB Flash]
  ├─ Core 0 (highest priority): SAS Polling Task (40 ms cycle)
  ├─ Core 0 (medium priority):  Network/MQTT Task
  └─ Core 0 (lowest priority):  Watchdog Task
      ↕ DM9051NP Ethernet onboard (SPI, RJ45 tích hợp)
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

> **Lưu ý single-core:** ESP32-C3 chỉ có 1 core. Không dùng `xTaskCreatePinnedToCore` với core khác nhau — tất cả task đều pinned to Core 0, tách biệt bằng FreeRTOS priority thay vì core affinity. SAS task chạy `configMAX_PRIORITIES-1` (highest), MQTT task chạy priority 5 (medium), Watchdog chạy priority 1 (lowest). UART `uart_read_bytes` block/yield trong deadline window → MQTT task vẫn có CPU time.

---

## So sánh với nhánh main

| Khía cạnh | `main` (Waveshare ESP32-S3-ETH) | `EVO` (WT32-ETH01-Evo) |
|---|---|---|
| MCU | ESP32-S3 Xtensa LX7 dual-core 240MHz | ESP32-C3 RISC-V single-core 160MHz |
| Flash | 8MB Octal | 4MB |
| Ethernet chip | W5500 | DM9051NP |
| SPI ETH pins | MOSI=11, MISO=12, SCLK=13, CS=14, RST=9 | MOSI=10, MISO=3, SCLK=7, CS=9, RST=6, INT=8 |
| SAS UART | UART2, TX=17, RX=16 | UART1, TX=18, RX=19 |
| Task isolation | Core pinning (SAS→Core1, MQTT→Core0) | FreeRTOS priority (tất cả Core 0) |
| 9-bit UART SAS | Không rõ (có thể hardware mark/space) | **Software Dynamic Parity** — EVEN/ODD per-byte |
| PlatformIO platform | `espressif32 ^6.6.0` | `pioarduino` (fork, có DM9051 support) |
| USB upload | USB CDC native | **KHÔNG có** — phải dùng FTDI qua debug header |
| Boot mode pin | GPIO0 | **GPIO9** (cũng là DM9051 CS) |
| LED user | Không xác định | GPIO5=RED, GPIO2=GREEN (active-LOW) |

---

## Trạng thái codebase

| Layer | Trạng thái | Ghi chú |
|---|---|---|
| Firmware (main, SAS, ETH, MQTT, Watchdog) | ✅ Hoàn chỉnh + boot test passed | Tất cả task khởi động đúng, DM9051 init OK |
| Backend entities, modules, gateway | ✅ Hoàn chỉnh | |
| Backend tournament (multi-round + history) | ✅ Hoàn chỉnh | `session_id`, `session_name`, `round_number`, `total_rounds`; cancel/end tách biệt |
| Backend player management | ✅ Hoàn chỉnh | `PlayerEntity`, `PlayerModule`, CRUD `/api/players` |
| Backend round results | ✅ Hoàn chỉnh | `RoundResultEntity` — chỉ lưu khi timer hết tự nhiên |
| Backend machine controller | ✅ Hoàn chỉnh | `GET /api/machines` + PATCH, commands |
| Backend jackpot | ✅ Hoạt động | |
| Scoring logic | ✅ Credits-based | Score = credits hiện tại (không phải coin_in delta) |
| Frontend control-panel | ✅ Hoàn chỉnh | Tabbed panel: Machines / History / Players |
| Frontend leaderboard (:5174) | ✅ Hoàn chỉnh | Xóa máy offline khỏi bảng |
| TypeORM migrations | ⚠️ Chưa có | Dev dùng `synchronize: true` |
| SAS end-to-end với máy slot thật | ✅ Đã test thành công (2026-09-05) | General Poll + Credits (LP 0x1A) đọc đúng, CRC valid. Xem mục **"Nhật ký debug SAS với máy thật (2026-09)"** phía dưới để biết toàn bộ lỗi đã gặp và cách sửa. Meters (LP 0xAF) vẫn chưa có phản hồi từ máy — xem "Việc còn tồn đọng" cuối mục đó. |

---

## Cấu trúc thư mục

```
ESP32-Tourney/
├── firmware/
│   ├── platformio.ini          # env: eth01evo (main), led-test (smoke test), native (unit tests)
│   ├── include/config.h        # TẤT CẢ pin DM9051, baud, IP, topic MQTT → chỉnh tại đây
│   ├── test_led/
│   │   └── main.cpp            # LED smoke test: GPIO5 RED + GPIO2 GREEN fade sine
│   └── src/
│       ├── main.cpp            # Boot sequence + task spawn (single-core ESP32-C3)
│       ├── sas/
│       │   ├── sas_polling.h/cpp   # FreeRTOS task, Dynamic Parity 9-bit, 40ms cycle
│       │   ├── sas_commands.h/cpp  # AFT 0x72/0x74; LP simple commands
│       │   └── crc16.h/cpp         # CRC-16/ARC
│       ├── network/
│       │   ├── eth_manager.h/cpp   # DM9051 DHCP init via ETH.h (pioarduino Arduino Core 3.x)
│       │   └── mqtt_client.h/cpp   # PubSubClient wrapper, reconnect loop
│       └── watchdog/
│           └── watchdog_task.h/cpp # 2s hardware watchdog, NVS pending txn recovery
├── backend/                    # NestJS — không đổi so với nhánh main
├── frontend/                   # React — không đổi so với nhánh main
├── sim_esp32.py                # Simulator MQTT
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

- **SAS polling ≤ 40 ms** – yêu cầu cứng SAS 6.0x. Task SAS chạy `configMAX_PRIORITIES-1` (highest) trên Core 0.
- **9-bit UART bằng Software Dynamic Parity** – ESP32-C3 không có UART hardware 9-bit (MARK/SPACE không tồn tại trong ESP-IDF `hal/uart_types.h`). Thay vào đó: với mỗi byte, chọn EVEN hoặc ODD parity sao cho bit parity kết quả = giá trị bit9 mong muốn (`uart_set_parity_for_bit9()` trong `sas_polling.cpp`). Address bytes → bit9=1, Data bytes → bit9=0. Đã xác minh bằng unit test native.
- **`uart_wait_tx_done()` sau mỗi byte** – bắt buộc. Thay đổi parity register mid-shift sẽ corrupt bit9 trên wire.
- **DISABLE ≠ LOCK** – LOCK = LP 0x01 Shutdown; DISABLE = LP 0x01 + delay 40ms + LP 0x07 Disable Bill. CMD_DISABLE=4, CMD_ENABLE=5, CMD_LOCK=2, CMD_UNLOCK=3.
- **NVS persistence** – watchdog khởi động lại phải recover `pending_txn_id` từ NVS. Không mất transaction đang chờ.
- **TypeORM `synchronize: true` chỉ ở dev** – production dùng migrations.
- **Jackpot hit_value là bí mật** – không log ra ngoài.
- **`end()` / `cancel()` atomic** – `UPDATE WHERE status=ACTIVE`; nếu `affected=0` return ngay.

---

## Lệnh phát triển

### Firmware (PlatformIO)

```bash
cd firmware

# Build firmware chính
pio run -e eth01evo

# Build + flash (board phải ở boot mode trước — xem bên dưới)
pio run -e eth01evo --target upload

# Serial monitor
pio device monitor -e eth01evo   # 115200 baud, cổng COM thật của FTDI (đã dùng COM7 khi debug SAS 2026-09; đổi theo máy, xem Device Manager)

# LED smoke test
pio run -e led-test --target upload

# Unit tests (host, không cần board)
pio test -e native
```

#### Boot mode + upload (xem chi tiết tại mục Hardware → Quy trình vào Boot Mode)
```
1. Jumper: J6-3 (GPIO9) → GND
2. Pulse EN: J3-1 → GND rồi thả
3. Thả jumper GPIO9
4. Chạy lệnh upload ngay
```

#### Upload flags bắt buộc (đã có trong platformio.ini)
```ini
upload_flags =
    --before=no_reset
    --after=no_hard_reset
```
Không có 2 flags này → esptool thử RTS/DTR reset → fail.

### Backend
```bash
cd backend
cp .env.example .env
npm install
npm run start:dev        # :3000
```

### Frontend
```bash
cd frontend/control-panel && npm install && npm run dev   # :5173
cd frontend/leaderboard   && npm install && npm run dev   # :5174
```

### Docker (services)
```bash
docker-compose up -d postgres redis mosquitto
docker-compose logs -f backend
```

### Giả lập ESP32 (không cần phần cứng)
```bash
pip install paho-mqtt
python sim_esp32.py
```

---

## Hardware — WT32-ETH01-Evo

**MCU:** ESP32-C3 (RISC-V RV32IMC, single-core 160MHz, 4MB Flash)
**Ethernet:** DM9051NP onboard (SPI, internal traces, KHÔNG thay đổi pin)
**Schematic:** S3-ETH-MAIN Rev V1.1 (Smart Panlee, 2023-04-06)

### Pin mapping DM9051 (internal traces, KHÔNG đấu dây thêm)

| Tín hiệu | GPIO | Ghi chú |
|---|---|---|
| SPI MOSI | 10 | |
| SPI MISO | 3 | cũng là UART0 RXD0 trên debug header |
| SPI SCLK | 7 | |
| SPI CS | **9** | **cũng là strapping boot pin** — idle-HIGH = boot bit=1 = consistent |
| ETH RST | 6 | |
| ETH INT | 8 | |

**GPIO cấm dùng:** 3, 6, 7, 8, 9, 10 (DM9051) · 18, 19 (SAS UART1)

**Strapping pins ESP32-C3:** GPIO2, GPIO8, GPIO9 — GPIO8/9 đã bị DM9051 chiếm (OK), GPIO2 là EXT_TXD và LED GREEN (safe as OUTPUT sau boot).

### SAS UART

| | GPIO |
|---|---|
| TX (→ MAX3232 → máy slot) | **18** |
| RX (← MAX3232 ← máy slot) | **19** |
| UART number | UART1 |
| Baud | 19200 |

UART0 (GPIO1/GPIO3 trên debug header) dùng riêng cho Serial monitor và flashing.

### LED onboard (xác nhận từ schematic + thực nghiệm)

| Component | GPIO | Màu | Kết nối | Logic |
|---|---|---|---|---|
| D1 | **5** | ĐỎ | EXT_RXD → 1KΩ → +3V3 | Active-LOW |
| D2 | **2** | XANH | EXT_TXD → 1KΩ → +3V3 | Active-LOW |
| D3 | — | ĐỎ | +3V3 → 1KΩ | Power indicator, luôn sáng |

`analogWrite(pin, 0)` = full brightness, `analogWrite(pin, 255)` = tắt.

### EXT Port (RS485 onboard — không dùng cho SAS)

Board có transceiver RS485 onboard qua EXT port:
- GPIO2 = EXT_TXD (cũng là LED GREEN)
- GPIO4 = EXT_485_DE (direction enable)
- GPIO5 = EXT_RXD (cũng là LED RED)

SAS của chúng ta dùng UART1 GPIO18/19 + MAX3232 external, không phải RS485 port này.

### Sơ đồ chân EXT Port (J3 + J6)

Board WT32-ETH01-Evo có 2 hàng header song song (J3 trái, J6 phải), mỗi hàng 13 pin:

```
          J3 (trái)          J6 (phải)
          ─────────          ──────────
  1 ── ESP_EN (Reset)    C3_TX0 (GPIO1)  ── 1   ← UART0 TX (flashing/monitor)
  2 ── GND               C3_RX0 (GPIO3)  ── 2   ← UART0 RX (flashing/monitor)
  3 ── +3V3              C3_IO9 (GPIO9)  ── 3   ← BOOT MODE PIN
  4 ── ESP_EN (Reset)    (NC)            ── 4
  5 ── EXT_CFG           C3_IO7 (GPIO7)  ── 5   [DM9051 SCLK – không dùng]
  6 ── EXT_485_DE        C3_IO6 (GPIO6)  ── 6   [DM9051 RST – không dùng]
  7 ── EXT_RXD (GPIO5)   C3_IO5 (GPIO5)  ── 7   ← LED RED (D1)
  8 ── EXT_TXD (GPIO2)   C3_IO4 (GPIO4)  ── 8   ← RS485 DE
  9 ── GND               C3_IO3 (GPIO3)  ── 9
 10 ── +3V3              C3_IO2 (GPIO2)  ── 10  ← LED GREEN (D2)
 11 ── GND               C3_IO1 (GPIO1)  ── 11
 12 ── ETH_STA_LINK      C3_IO0 (GPIO0)  ── 12
 13 ── (POE)             GND             ── 13
```

> **Lưu ý:** GPIO3 xuất hiện cả ở J6-2 (C3_RX0 UART0) và J6-9 (C3_IO3) — đây là cùng một pin, share giữa UART0 debug và DM9051 MISO (internal trace). Không dùng J6-9 khi đang flash.
>
> **Sửa lỗi tài liệu (2026-09-04):** J3-4 trước đây ghi nhầm là GND — theo datasheet gốc (`hardware/WT32-ETH01-EVO-Datasheet-V2.0EN.pdf`, Extension Interface A) và sơ đồ mạch, **J3-4 thực chất là ESP_EN thứ hai (cùng net với J3-1)**. Có thể dùng J3-1 hoặc J3-4 để pulse EN khi vào boot mode — tương đương nhau về điện, thử chân còn lại nếu một chân tiếp xúc kém. Các pin J3-9 → J3-13 chưa được đối chiếu lại kỹ với datasheet, cần xác minh vật lý (đo continuity) trước khi tin tưởng hoàn toàn.

---

### Quy trình vào Boot Mode (Download Mode)

Board **không có auto-reset circuit** — esptool không tự kéo EN/GPIO9 được. Phải thao tác tay:

```
Bước 1: Nối dây jumper từ J6-3 (GPIO9) → GND (J3-2 hoặc J3-4 hoặc J3-9)
         ┌─────────────────────────────────────────────┐
         │  GPIO9 ──── GND  (GIỮ LIÊN TỤC bước 1→2)  │
         └─────────────────────────────────────────────┘

Bước 2: Pulse EN reset:
         J3-1 (ESP_EN) ──── GND  (nhấn hoặc short 0.5s)
         J3-1 (ESP_EN) ──── thả ra

Bước 3: Thả jumper GPIO9 khỏi GND
         Board bây giờ đang chờ esptool kết nối — không reset, không timeout

Bước 4: Chạy lệnh upload NGAY:
         pio run -e eth01evo --target upload
```

**Dấu hiệu vào boot mode thành công:** esptool in `Connecting....` rồi `Connected to ESP32-C3`.
**Dấu hiệu thất bại:** `No serial data received` → lặp lại từ bước 1, kiểm tra dây jumper tiếp xúc tốt.

> **Phát hiện (2026-09-04): pulse EN (bước 2) không đáng tin cậy trên board này.** Đã xác minh trực tiếp bằng cách nghe COM7 trong lúc pulse EN — uptime counter của firmware **không hề reset**, chứng tỏ pulse EN qua J3-1 nhiều lần không thực sự kéo được EN xuống GND (khả năng do tiếp xúc jumper kém, không phải sai chân). **Quy trình thay thế đã xác nhận hoạt động ổn định:** thay vì pulse EN ở bước 2, **rút và cắm lại nguồn cấp cho board (power-cycle toàn bộ)** trong khi vẫn giữ GPIO9→GND, giữ thêm ~1-2s sau khi có nguồn lại rồi mới thả GPIO9. Ưu tiên dùng cách này thay vì pulse EN nếu upload liên tục báo `No serial data received`. Cũng lưu ý: sau khi flash xong, esptool in `Hard resetting via RTS pin` nhưng dòng này **không có tác dụng thật** trên board (không có auto-reset circuit) — cần power-cycle thêm 1 lần nữa (KHÔNG giữ GPIO9 lần này) để board boot vào firmware vừa nạp.

---

### Nối dây FTDI Adapter (flashing + serial monitor)

```
FTDI Adapter          WT32-ETH01-Evo
────────────          ──────────────
TX          ─────────→ J6-2  (RXD0 / GPIO3)
RX          ←───────── J6-1  (TXD0 / GPIO1)
GND         ─────────── J3-2  (GND)
VCC (5V)    ✗ KHÔNG NỐI — board tự có nguồn từ JW3510
```

> **Nguồn khi flash:** JW3510 cấp điện qua cách ly galvanic có thể drop voltage lúc esptool write SPI flash (~400mA inrush). Nếu flash fail tại bước SFDP: cấp nguồn trực tiếp USB 1A+ vào ESP32-C3 VSYS (bypass JW3510), GND chung với FTDI.

---

### Nối dây V0259 (RS232 ↔ GPIO18/19)

```
V0259 Module (TTL side)    WT32-ETH01-Evo
───────────────────────    ──────────────
TXD  ──────────────────→   GPIO18  (SAS UART1 RX của ESP32-C3)
RXD  ←──────────────────   GPIO19  (SAS UART1 TX của ESP32-C3)
GND  ─────────────────────  GND_A   (cùng ground với ESP32-C3)
5V0  ─────────────────────  +5V từ JW3510 output (hoặc +3V3 nếu module hỗ trợ)

V0259 Module (RS232 side)  Máy Slot
───────────────────────    ────────
TXD (RS232)  ─────────────  RXD máy slot
RXD (RS232)  ─────────────  TXD máy slot
GND (RS232)  ─────────────  GND_RS232 máy slot (isolated)
```

> V0259 tự tích hợp CTTF0505-1T (power isolation) + 122M31 (signal isolation). GND phía RS232 hoàn toàn cách ly với GND_A của ESP32-C3.

---

### Nối dây JW3510 DYXK112 (nguồn isolated cho ESP32-C3)

```
JW3510 (input)     Máy slot
──────────────     ────────
IN+  ─────────────  +5V máy slot
IN-  ─────────────  GND máy slot

JW3510 (output)    WT32-ETH01-Evo
───────────────    ──────────────
OUT+ (5V iso) ────  VSYS hoặc 5V pin của board
OUT- (GND_A)  ────  GND của board (cũng nối với GND của V0259 TTL side)
```

### Kiến trúc cách ly galvanic (thực tế)

```
Máy slot 5V ──────┬──────────────────────────────────────────
Máy slot GND ─────┤
                  │
      ┌───────────┴────────────┐
      │                        │
 [JW3510 DYXK112]        [V0259 Module]
  DC-DC isolated ≤4W      MAX3232 + CTTF0505-1T + 122M31
  GND_A (isolated)        RS232 side isolated từ TTL side
  → ESP32-C3 VSYS         → GPIO18 (RX) / GPIO19 (TX)
```

- **3 ground hoàn toàn độc lập:** GND máy slot · GND_A (ESP32) · GND_RS232 side
- Cách ly đạt được bằng module chuyên dụng — không cần rời từng linh kiện

| Module | Model | Chức năng | Ghi chú |
|---|---|---|---|
| **WT32-ETH01-Evo** | WAVGAT | MCU board ESP32-C3 + DM9051 ETH | Board chính |
| **Isolated RS232↔TTL** | V0259 | RS232 ↔ 5V TTL, cách ly điện + tín hiệu hoàn toàn | Power iso: **CTTF0505-1T** (Mornsun 1W SMD); Signal iso: **122M31** digital isolator; wiring: TXD→RXD / RXD→TXD / GND→GND |
| **Isolated DC-DC** | JW3510 DYXK112 | Input DC3~36V → output isolated 5V, ≤4W | Cấp nguồn cho ESP32-C3 VSYS từ 5V máy slot; hiệu suất ≤85%; bảo vệ ngắn mạch, quá tải, quá nhiệt |

**QUAN TRỌNG khi flash firmware:** JW3510 cấp nguồn qua cách ly → khi flash phải cấp trực tiếp từ USB 1A+ với GND chung FTDI (tránh drop voltage do inrush SPI flash write ~400mA). Khi vận hành bình thường: JW3510 ≤4W = đủ.

---

## Nhật ký debug SAS với máy thật (2026-09)

Phiên làm việc 2026-09-04 → 2026-09-05: lần đầu đấu nối và đọc dữ liệu SAS từ **máy slot thật** (trước đó chỉ test loopback/giả lập). Ghi lại đầy đủ ở đây vì hành trình debug dài, nhiều lần đoán sai hướng — mục đích để **lần sau (máy khác, hoặc cùng máy) không phải lặp lại từ đầu.**

### Tóm tắt kết quả cuối cùng

✅ General Poll và Credits (LP 0x1A) đọc đúng, ổn định, CRC valid 100%.
⚠️ Meters (LP 0xAF) chưa có phản hồi từ máy này — xem "Việc còn tồn đọng".
🔑 **Nguyên nhân gốc của phần lớn thời gian debug: dây GND trong cáp RS232 nối V0259 ↔ máy slot bị sai/thiếu.** Không phải lỗi firmware, không phải điện áp nguồn, không phải framing UART — dù cả 3 thứ đó cũng có lỗi thật sự cần sửa (xem bên dưới) và **đã sửa xong**, chúng không phải nguyên nhân chính khiến không đọc được dữ liệu.

### 3 lỗi firmware đã tìm thấy và sửa (xác nhận qua unit test + hardware thật)

**1. Bảng tên exception (`exc_name()` trong `sas_polling.cpp`) sai 5/7 mã**

Bảng cũ chỉ đúng ngẫu nhiên 2 mã (0x11, 0x12 — cửa mở/đóng), 5 mã còn lại sai hoàn toàn khi đối chiếu với **Appendix A, tài liệu gốc SAS 6.02** (IGT/GSA, do người dùng cung cấp trực tiếp trong phiên chat):

| Mã | Tên cũ (SAI) | Tên đúng theo Appendix A |
|---|---|---|
| 0x26 | "Cashout button pressed" | *(không tồn tại trong bảng chuẩn — mã cashout thật là 0x66)* |
| 0x27 | "Reel spin begin (game started)" | "Cashbox full detected" |
| 0x44 | "Handpay pending" | "Reel 4 tilt" (handpay pending thật là 0x51) |
| 0x4C | "Cashout ticket printed" | "$100.00 bill accepted" (ticket printed thật là 0x3D) |
| 0x67 | "AFT transfer complete" | "Ticket has been inserted" (AFT complete thật là 0x69) |

Đã viết lại toàn bộ bảng theo Appendix A, mở rộng thêm ~15 mã (AC power, general tilt, handpay reset, AFT host-cashout request, game locked 0x6F...). **Bài học: đừng đoán mã exception nếu chưa đối chiếu tài liệu gốc — bảng cũ đã tồn tại "đúng ngẫu nhiên" đủ lâu để trông đáng tin, dù thực chất sai gần hết.**

**2. Credits/Meters/AFT/Handpay luôn bị cắt cụt phản hồi (timeout quá ngắn)**

`SAS_RESPONSE_TIMEOUT` (20ms, dùng chung cho mọi giao dịch) quá ngắn cho các Long Poll trả về nhiều byte. Đo trực tiếp trên máy thật: Credits (LP 0x1A, cần đủ 8 byte) luôn bị cắt ở 3-4 byte, không bao giờ qua được CRC. Tách riêng `SAS_LONG_POLL_TIMEOUT = 100ms` cho Credits/Meters/AFT/Handpay (General Poll vẫn giữ 20ms vì chạy mỗi 40ms/lần, không có nhiều slack). Worst-case tính theo spec: 20ms response window + tối đa 5ms/byte × 15 byte (Meters, khung dài nhất) = 95ms → 100ms đủ dư.

**3. General Poll dùng framing sai chuẩn, khiến máy chỉ echo lại chứ không báo cáo exception thật**

Code cũ gửi địa chỉ máy **2 lần liên tiếp** với bit9=1 (MARK) cả 2 byte — không đúng chuẩn SAS (chuẩn là 1 byte địa chỉ duy nhất). Trên máy thật, cách này khiến máy **echo lại chính xác byte mình gửi** thay vì trả về exception code — capture được hàng nghìn lần liên tiếp giống hệt nhau, kể cả khi chủ động rút/đóng cửa máy (không có gì thay đổi).

Đã tham khảo dự án **SASPyTourney** (github.com/jakeliedo/SASpyTourney, dùng thư viện cộng đồng `saspy` — github.com/zacharytomlinson/saspy) mà người dùng xác nhận đã chạy thành công thực tế trước đây. Phát hiện cơ chế framing thật của SAS trên phần cứng thật khác hẳn lý thuyết sách vở:

- **General Poll:** gửi 2 byte thô `[SAS_POLL_ADDRESS(0x82), 0x80 | địa_chỉ_máy]`, với **KHÔNG parity + 2 stop-bit** (không dùng bit9 MARK/SPACE như Long Poll).
- **Long Poll:** thêm "preamble" 2 byte MARK `[SAS_POLL_ADDRESS, địa_chỉ_máy]` TRƯỚC cmd/data/CRC (SPACE), thay vì chỉ 1 byte địa chỉ MARK như code cũ.

Copy machine y hệt cách pyserial làm (PC) sang ESP32 **chưa đủ** — thêm 1 lỗi nữa phải tự tìm ra: cấu hình "parity NONE + 2 stop-bit" khi ĐỌC phản hồi General Poll khiến ESP32 UART hardware coi là lỗi framing (vì byte phản hồi thật có bit9=0, không phải "2 bit stop=1" như ESP32 UART kỳ vọng) — PC dễ dãi hơn với lỗi này nên kỹ thuật gốc "chạy được" trên PC. Sửa: chuyển sang parity cố định (EVEN, không quan trọng giá trị) + 1 stop-bit khi đọc, khớp đúng khung 11-bit thật của SAS.

**Lưu ý quan trọng: dù đã sửa đúng cả 2 lỗi trên (framing General Poll + đọc phản hồi), dữ liệu vẫn nhiễu (xem phần debug phần cứng bên dưới) cho tới khi thay cáp RS232 đúng dây GND — tức đây thực sự là 2 lỗi ĐỘC LẬP, cả hai đều cần sửa, không lỗi nào "che" lỗi kia.**

### Hành trình debug phần cứng (đường dây RS232 → máy slot)

Sau khi sửa 3 lỗi firmware trên, General Poll vẫn chỉ trả về echo của chính byte gửi đi (từ "01" khi dùng framing cũ, sang "82" khi dùng framing mới — luôn đúng bằng byte đầu tiên vừa TX). Thứ tự loại trừ nguyên nhân, **theo đúng trình tự đã làm, để lần sau không mất công thử lại các hướng đã loại trừ:**

1. **Rút dây RS232 khỏi máy (V0259 để lơ lửng):** im lặng hoàn toàn (no response), không còn echo. → **Loại trừ:** không phải lỗi loopback nội bộ trong V0259/board — echo chỉ xảy ra khi có kết nối thật tới máy.
2. **Đổi nguồn V0259 từ 3.3V sang 5V, đo lại điện áp TX (hở mạch, RS232 side):** đo được **-5.7V y hệt cả hai mức nguồn**. → **Loại trừ:** điện áp nguồn cấp (3.3V vs 5V) không phải nguyên nhân — driver RS232 bão hòa ở cùng mức áp bất kể nguồn.
3. **Đảo dây TXD/RXD giữa V0259 và máy:** hiện tượng echo biến mất hoàn toàn, thay bằng phần lớn im lặng + thỉnh thoảng nhiễu dạng số gần `0xFF` (`F0, FF, E0, F1, FD, F9, E1`...). → Xác nhận hướng dây "đảo" đúng hơn hướng cũ, nhưng vẫn chưa sạch.
4. **Đo điện áp khi đã nối lại máy (có tải thật):** RX = **-7.3V**, TX = **-5.5V** — cả hai đều là mức RS232 hợp lệ, ổn định, đúng chuẩn (mark/idle). → **Loại trừ:** không phải floating/hở mạch, không phải thiếu điện áp — máy THẬT SỰ đang chủ động phát tín hiệu RS232 hợp lệ vào V0259.
5. **Nhưng dữ liệu số vẫn nhiễu dù điện áp DC tốt** → sửa framing UART (mục lỗi #3 ở trên: NONE-parity+2-stopbit → EVEN-parity+1-stopbit khi đọc General Poll) — build lại, test lại: **nhiễu vẫn y hệt, không đổi.** → **Loại trừ:** không phải lỗi framing UART (dù lỗi đó có thật và đã sửa đúng, nó không phải nguyên nhân của nhiễu này).
6. **Đổi sang cáp COM/RS232 khác, đảm bảo đúng thứ tự dây (đặc biệt là GND):** → **Dữ liệu sạch hoàn toàn ngay lập tức.** General Poll ổn định ở `0x00` ("No activity", mã chuẩn), Credits trả về đủ 8 byte, CRC khớp 100%, 0 lỗi trong suốt 40 giây log.

**Bài học chính:** dây GND đi kèm tín hiệu RS232 (không phải chỉ TXD/RXD) quan trọng ngang hoặc hơn cả TXD/RXD — thiếu/sai GND không gây im lặng hoàn toàn (vẫn có "tín hiệu" gì đó, dễ đánh lừa là đang debug đúng hướng), mà gây **nhiễu bit ngẫu nhiên trông giống lỗi framing/timing/echo**, khiến dễ đi sai hướng debug (nghi ngờ voltage, nghi ngờ framing UART, nghi ngờ máy chưa bật SAS...) rất lâu trước khi nghĩ tới cáp/GND. **Lần sau nếu gặp lại triệu chứng "nhiễu dạng gần 0xFF, lệch vài bit, không cố định" dù điện áp DC đo được vẫn đúng chuẩn RS232 — kiểm tra cáp/dây GND TRƯỚC, đừng lặp lại việc dò voltage/framing/wire-orientation trước.**

### Cách chẩn đoán TX/RX thật trên cổng SAS của máy (không cần tin nhãn in trên connector)

Mẹo hữu ích rút ra được: đo điện áp trực tiếp trên connector của máy (chưa cắm gì) —
- Chân nào ra điện áp **âm ổn định** (khoảng -5V đến -12V) dù không tải → đó là **TX thật** của máy (driver chủ động phát, không phụ thuộc có tải).
- Chân nào đo gần **0V** khi không tải → đó là **RX thật** của máy (chỉ nhận, không có gì chủ động kéo điện áp khi chưa nối).

Không nên tin nhãn TX/RX in trên đầu nối — quy ước ghi nhãn theo góc nhìn thiết bị A hay thiết bị B rất hay gây nhầm lẫn trong RS232.

### Việc còn tồn đọng

- **Meters poll (LP 0xAF – "Send extended meters, alternate") không có phản hồi từ máy này**, dù Credits (LP 0x1A) và General Poll đều hoạt động tốt cùng lúc, cùng framing. Máy được nhắc tới trong tài liệu SAS 6.02 gốc ghi "distributed to Euro Games Technology LTD" — nghi ngờ đây là máy EGT, có thể không hỗ trợ đúng lệnh 0xAF hoặc cần tham số khác (game_number/denom). **Chưa thử:** các lệnh Long Poll meters cũ hơn (dải 0x0F trở xuống theo Appendix B), hoặc kiểm tra máy có yêu cầu "AFT enable"/cấu hình bổ sung trước khi trả lời 0xAF.
- Pin J3-9 → J3-13 trên header EXT Port (xem mục Sơ đồ chân EXT Port) vẫn chưa được đối chiếu lại kỹ với datasheet — chỉ mới sửa xong J3-4.
- Chưa kiểm tra menu operator/audit trên máy slot để xác nhận SAS address cấu hình và trạng thái "Host Controlled" — không cần thiết nữa vì đã đọc được dữ liệu thật, nhưng nếu gặp lại máy "im lặng hoàn toàn" (không phải nhiễu) ở một máy khác, đây là việc nên kiểm tra sớm.

---

## Cấu hình Firmware (config.h)

**Tất cả pin DM9051 là internal traces — KHÔNG chỉnh.** Chỉ thay đổi các define sau trước khi flash cho từng máy:

| Define | Giá trị mặc định | Ghi chú |
|---|---|---|
| `SAS_MACHINE_ADDRESS` | `0x01` | Địa chỉ SAS (1–127), mỗi máy khác nhau |
| `SAS_POLL_ADDRESS` | `0x82` | **Mới (2026-09-05).** Byte "wakeup" cố định gửi trước địa chỉ máy thật trên mọi giao dịch SAS — xem mục "Nhật ký debug SAS với máy thật (2026-09)". Thử `0x80` nếu `0x82` không nhận được phản hồi trên một máy cụ thể. |
| `SAS_RESPONSE_TIMEOUT` | `20` ms | Timeout cho General Poll (chạy mỗi chu kỳ 40ms, phải ngắn) |
| `SAS_LONG_POLL_TIMEOUT` | `100` ms | **Mới (2026-09-05).** Timeout cho Credits/Meters/AFT/Handpay (chạy thưa hơn, có thể chờ lâu hơn). Trước đây là 35ms → luôn bị cắt cụt phản hồi thật (đo được máy cần tới ~95ms cho frame 16 byte trong trường hợp xấu nhất). |
| `MQTT_BROKER_HOST` | `"192.168.1.100"` | IP server chạy Mosquitto |
| `MQTT_CLIENT_ID` | `"GMI-Machine-01"` | Phải unique trên toàn broker |
| `MQTT_TOPIC_*` | `casino/machine/01/...` | Phải khớp với machine ID |

---

## Biến môi trường Backend

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DB_HOST/PORT/NAME/USER/PASS` | localhost/5433/esp32_tourney/... | PostgreSQL (port 5433 tránh conflict) |
| `REDIS_HOST/PORT` | localhost/6379 | Redis |
| `MQTT_HOST/PORT/USER/PASS` | localhost/1883/esp32/changeme | Mosquitto |
| `PORT` | 3000 | NestJS HTTP port |
| `NODE_ENV` | development | `production` tắt TypeORM sync |
| `JACKPOT_CONTRIBUTION_RATE` | 0.5 | % coin-in vào jackpot pool |
| `JACKPOT_BASE_AMOUNT` | 10000 | Credits pool reset sau jackpot |
| `JACKPOT_MAX_AMOUNT` | 1000000 | Giới hạn trên hit_value |

---

## Database Entities

- **MachineEntity** – `machine_id`, `display_name`, `credits`, `coin_in`, `coin_out`, `status` (ONLINE/OFFLINE/PLAYING/LOCKED/HANDPAY/DISABLED)
- **TransactionEntity** – `txn_id` (uuid), `type`, `status` (PENDING/SUCCESS/FAILED), `aft_status_code`, `amount`, `tournament_id`
- **TournamentEntity** – `machine_ids[]`, `initial_credits`, `duration_seconds`, `status` (SCHEDULED/ACTIVE/FINISHED/CANCELLED), `session_id`, `session_name`, `round_number`, `total_rounds`
- **PlayerEntity** – `membership_number` (PK), `display_name`
- **RoundResultEntity** – `tournament_id`, `machine_id`, `player_display`, `final_score`, `rank`, `advanced`, `session_id`, `round_number`, `total_rounds`

**Credits:** integer (10000 = $100.00). Hiển thị phải ÷100.

---

## Redis Keys

| Key | Kiểu | Nội dung |
|---|---|---|
| `machine:{id}:state` | Hash | credits, coin_in, coin_out, state, updated_at |
| `tourney:{id}:scores` | Sorted Set | member=machineId, score=credits; ZREM khi máy offline |
| `jackpot:pool` | String | Pool hiện tại (float) |
| `jackpot:hit_value` | String | Hit value bí mật (int) |

---

## API Endpoints (Backend :3000)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/machines` | Danh sách máy |
| PATCH | `/api/machines/:id` | Cập nhật display_name |
| POST | `/api/machines/:id/command` | Gửi lệnh (ENABLE/DISABLE/AFT_PUMP...) |
| POST | `/api/machines/aft-in-all` | AFT IN tất cả máy enabled |
| POST | `/api/machines/aft-out-all` | AFT OUT tất cả máy |
| GET | `/api/tournaments/history` | 8 rounds FINISHED gần nhất (`SessionDto[]`) |
| POST | `/api/tournaments` | Tạo tournament |
| POST | `/api/tournaments/:id/start` | Bắt đầu (ENABLE + init Redis scores) |
| POST | `/api/tournaments/:id/end` | Kết thúc tự nhiên |
| POST | `/api/tournaments/:id/cancel` | Huỷ thủ công (không lưu kết quả) |
| POST | `/api/tournaments/:id/next-round` | Round tiếp theo cùng session |
| GET/POST/PATCH/DELETE | `/api/players` | CRUD players |
| GET | `/api/jackpot/pool` | Jackpot pool hiện tại |

---

## WebSocket Events (Socket.IO `/leaderboard`)

| Event | Payload |
|---|---|
| `leaderboard_update` | `{ tournamentId, rankings[], roundNumber, totalRounds, endsAt }` |
| `jackpot_hit` | `{ machineId, amount }` |
| `machine_update` | `{ machineId, credits, coin_in, coin_out, status }` |
