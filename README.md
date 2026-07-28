# ESP32-Tourney

Hệ thống **Slot Tournament & Mystery Jackpot** dựa trên ESP32, W5500, giao thức SAS 6.0x.

## Cấu trúc dự án

```
ESP32-Tourney/
├── firmware/               # ESP32 C/C++ (PlatformIO)
│   ├── platformio.ini
│   ├── include/config.h
│   └── src/
│       ├── main.cpp
│       ├── sas/            # SAS protocol: polling, commands, CRC-16
│       ├── network/        # W5500 ETH.h + MQTT client
│       └── watchdog/       # Watchdog + NVS persistence
├── backend/                # NestJS (TypeScript)
│   └── src/
│       ├── device-gateway/ # MQTT broker interface + WebSocket
│       ├── tournament/     # Tournament Engine
│       ├── jackpot/        # Mystery Jackpot Engine
│       ├── database/       # TypeORM entities (PostgreSQL)
│       └── redis/          # Redis service (in-memory cache)
├── frontend/
│   ├── control-panel/      # React admin dashboard (port 5173)
│   └── leaderboard/        # React leaderboard 4K display (port 5174)
├── hardware/
│   └── wiring_guide.txt    # Sơ đồ nối dây ESP32/W5500/MAX3232
├── mosquitto/              # Mosquitto MQTT config
└── docker-compose.yml      # Toàn bộ stack: PG + Redis + MQTT + Backend
```

## Khởi động nhanh

### 1. Backend + Services (Docker)
```bash
cp backend/.env.example backend/.env
docker-compose up -d postgres redis mosquitto
cd backend && npm install && npm run start:dev
```

### 2. Frontend
```bash
# Control Panel
cd frontend/control-panel && npm install && npm run dev

# Leaderboard
cd frontend/leaderboard && npm install && npm run dev
```

### 3. Firmware (VS Code + PlatformIO)
1. Mở VS Code → cài extension **PlatformIO IDE**
2. Mở thư mục `firmware/`
3. Chỉnh `firmware/include/config.h` theo IP broker và GPIO thực tế
4. PlatformIO: **Build** → **Upload**

## Yêu cầu phần cứng
| Linh kiện | Mục đích |
|---|---|
| ESP32-WROOM-32 | MCU lõi kép |
| W5500 module | Ethernet LAN (thay Wi-Fi) |
| MAX3232 | RS232 ↔ TTL 3.3V |
| 6N137 Optocoupler | Cách ly điện galvanic |
| Mornsun B0505S-1W | Isolated DC-DC cho domain RS232 |

Xem chi tiết: `hardware/wiring_guide.txt`
