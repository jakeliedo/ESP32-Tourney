# CLAUDE.md — ESP32-Tourney Roadmap

File này theo dõi tiến độ triển khai dự án theo từng giai đoạn (phase). Quy tắc: mỗi khi hoàn thành một task, đổi `[ ]` → `[x]`; khi hoàn thành cả phase, đổi trạng thái phase thành ✅ DONE. Đây là tài liệu sống — cập nhật liên tục, không phải cố định một lần.

## Trạng thái tổng quan

- Phần cứng mục tiêu: **Waveshare ESP32-S3-ETH** (ESP32-S3R8, onboard W5500 qua SPI, có thể gắn thêm PoE HAT 802.3af rời).
- Cập nhật gần nhất: 2026-07-31

## Phase 0 — Scaffold ban đầu ✅ DONE

- [x] Cấu trúc project: firmware (PlatformIO) / backend (NestJS) / frontend (2 React app) / docker-compose
- [x] Firmware: SAS 6.0x polling, AFT transfer, watchdog, MQTT qua W5500
- [x] Backend: Tournament Engine, Mystery Jackpot Engine, Device Gateway, WebSocket leaderboard
- [x] Frontend: Control Panel (devices + tournament management), Leaderboard 4K display

## Phase 1 — Chuyển đổi phần cứng sang ESP32-S3-ETH 🔄 IN PROGRESS

- [x] Chọn module: Waveshare ESP32-S3-ETH (W5500 qua SPI — tương thích kiến trúc code hiện tại)
- [x] Cập nhật pin mapping W5500 trong [config.h](firmware/include/config.h) (MOSI=11, MISO=12, SCLK=13, CS=14, RST=9, INT=10)
- [x] Cập nhật [platformio.ini](firmware/platformio.ini): board → `esp32-s3-devkitc-1`, `qio_opi` PSRAM, partition `default_16MB.csv`
- [x] Xác nhận pin UART SAS — đối chiếu pinout chính thức Waveshare: GPIO16/17 tự do (không đụng SD_CS/SD_MISO trên GPIO4/5 như đã tạm đặt sai trước đó), giữ nguyên GPIO17=TX/GPIO16=RX
- [ ] Quyết định có dùng PoE HAT (802.3af) hay không; nếu có, xác nhận cách ly điện áp giữa domain PoE và domain RS232 hiện tại ([wiring_guide.txt](hardware/wiring_guide.txt))
- [x] Quyết định cơ chế định danh mỗi module — chọn hướng: sản xuất 12 module đánh số thứ tự, sửa + nạp firmware riêng cho từng module trước khi gán vào máy slot thực tế. Đã gộp định danh (SAS address, MQTT client ID, 4 MQTT topic) về **1 hằng số duy nhất `MACHINE_NUMBER`** trong `config.h` (dùng macro nối chuỗi lúc compile) — chỉ cần đổi 1 số, không còn lặp "01" thủ công ở nhiều chỗ
- [ ] Nạp firmware cho 12 module: đổi `MACHINE_NUMBER` = 1..12, build + flash từng cái, dán nhãn vật lý khớp số máy slot thực tế trong khu vực tournament
- [ ] Build thử firmware với board mới, flash test cơ bản (boot log, DHCP lấy IP, kết nối MQTT broker)

### Phương án dự phòng — định danh qua thẻ SD (đã ghi nhận, CHƯA triển khai)

Lợi ích: module hỏng có thể thay nhanh bằng cách chuyển thẻ SD sang module dự phòng đã nạp sẵn cùng 1 bản firmware chung — không cần laptop/reflash tại chỗ giữa lúc tournament.

- **Nội dung lưu trên thẻ SD**: chỉ 1 giá trị — `machine_number` (1–12), vì đây là giá trị per-device duy nhất trong toàn bộ config hiện tại (broker host, user/pass, pin mapping đều chung cho cả 12 module).
- **Định dạng khuyến nghị**: text thuần `/machine.txt` chứa 1 số — đơn giản cho kỹ thuật viên ngoài sàn. JSON `/config.json` (tái dùng ArduinoJson đã có sẵn) là lựa chọn thay thế nếu cần mở rộng thêm field sau này.
- **Yêu cầu an toàn bắt buộc**: nếu thẻ SD thiếu/lỗi/đọc không hợp lệ lúc boot → module phải vào trạng thái an toàn (không kết nối MQTT, không chạy AFT, chỉ báo lỗi qua LED/Serial). Tuyệt đối không fallback về số mặc định — 2 module trùng SAS address/MQTT topic có thể gây double AFT execution (rủi ro tài chính thật).
- **Thay đổi kiến trúc khi triển khai**: `MACHINE_NUMBER` chuyển từ hằng số compile-time sang biến runtime đọc từ SD lúc boot (trước `eth_manager_init()`/`mqtt_client_init()`); `MQTT_CLIENT_ID`/`MQTT_TOPIC_*` phải đổi từ macro nối chuỗi compile-time sang build bằng `snprintf` lúc runtime. File ảnh hưởng: `main.cpp`, `mqtt_client.cpp`, `eth_manager.cpp`.
- **Trạng thái hiện tại**: đang dùng hướng nạp riêng từng module (12 module đánh số cố định trong firmware). Thẻ SD là phương án nâng cấp dự phòng, sẽ triển khai nếu cần thay module nhanh trong lúc vận hành thực tế.

## Phase 2 — Hoàn thiện Backend ⬜ TODO

- [ ] Bổ sung `MachineController` (REST API `GET /api/machines`) — frontend đã gọi ([api.ts](frontend/control-panel/src/services/api.ts)) nhưng backend chưa có route
- [ ] Viết TypeORM migration thay cho `synchronize: true` (an toàn hơn cho production)
- [ ] Validation input (class-validator DTO) cho tournament/jackpot API
- [ ] Unit test cho `TournamentService`, `JackpotService`

## Phase 3 — Kiểm thử Firmware trên phần cứng thật ⬜ TODO

- [ ] Test kết nối SAS thật với máy slot (hoặc SAS simulator)
- [ ] Test luồng AFT pump/withdraw đầu-cuối (server → MQTT → ESP32 → SAS → máy)
- [ ] Test watchdog reset khi SAS task treo
- [ ] Test khôi phục giao dịch treo qua NVS sau mất điện

## Phase 4 — Tích hợp Frontend end-to-end ⬜ TODO

- [ ] Test Control Panel với backend thật (tạo/start/end tournament, xem device dashboard)
- [ ] Test Leaderboard 4K nhận cập nhật real-time + overlay jackpot

## Phase 5 — Chuẩn bị triển khai thực tế ⬜ TODO

- [x] Chọn phần cứng Control PC — tái sử dụng mainboard **AEWIN MB-8390 REV.A1** (Mini-ITX, thiết kế cho AMD Embedded R-Series, gốc digital signage/POS/kiosk) sẵn có, thay thế hoàn toàn máy dev Windows khi chạy thật. Xuất hình 3×HDMI+1×DP (đủ 2 màn hình Control Panel + Leaderboard). RAM 8GB (2×4GB DDR3L-1600), lưu trữ thẻ CFast 16/32GB. Mạng: chạy standalone, 1 LAN nối switch chính (chung với 12 module ESP32), 1 LAN dự phòng cho internet. Chi tiết & nguồn tham khảo: xem plan `t-i-c-m-t-mainboard-robust-dragonfly.md`.
- [ ] Chốt CPU cho Control PC: đang chạy **A10-5700M** (4 core, mạnh nhất, nhưng không nằm trong whitelist BIOS chính thức của AEWIN — phải bấm Enter qua cảnh báo mỗi lần boot) — cân nhắc thử **R-464L** (4 core, cùng TDP 35W, nằm trong whitelist CPU chính thức cùng dòng R-series như R-272F, khả năng cao boot sạch không cần Enter). R-272F là phương án dự phòng cuối nếu 2 CPU trên có vấn đề.
- [ ] Cài đặt hạ tầng trên Control PC theo hướng **native Windows, không dùng Docker Desktop/WSL2** (khác máy dev) để tiết kiệm RAM/CPU trên phần cứng yếu: PostgreSQL (installer chính thức), Mosquitto (installer chính thức), Redis qua bản port Windows (tporadowski/redis hoặc Memurai), Node.js LTS cho backend + 2 frontend build sẵn, chạy nền qua NSSM/pm2 để tự khởi động cùng Windows.
- [ ] Bảo mật Mosquitto (TLS, ACL theo machine_id)
- [ ] Hạ tầng PoE switch/injector nếu dùng PoE
- [ ] Giám sát/logging production
- [ ] Docker production hardening (secrets thật, không dùng password mặc định trong `.env`) — áp dụng cho máy dev/CI, Control PC dùng hướng native ở trên
