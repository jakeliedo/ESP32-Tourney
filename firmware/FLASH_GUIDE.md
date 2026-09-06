# Hướng dẫn nạp firmware WT32-ETH01-Evo

Board **không có auto-reset circuit** — esptool không thể tự kéo EN/GPIO9.
Phải vào boot mode bằng tay trước mỗi lần flash.

---

## 1. Phần cứng cần thiết

| Thiết bị | Ghi chú |
|---|---|
| FTDI adapter (FT232RL hoặc CH340) | 3.3 V TX/RX |
| Dây jumper 2 sợi | GPIO9→GND + EN→GND |
| Cáp USB | Nối FTDI vào laptop |

**Kết nối FTDI:**

```
FTDI          WT32-ETH01-Evo header
────          ──────────────────────
TX   ───────→ J6-2  (RXD0 / GPIO3)
RX   ←─────── J6-1  (TXD0 / GPIO1)
GND  ───────── J3-2  (GND)
VCC  ✗ KHÔNG nối — board tự có nguồn
```

---

## 2. Vào Boot Mode (download mode)

```
Bước 1 — Jumper: J6-3 (GPIO9) → GND  [GIỮ SUỐT bước 1→2]
Bước 2 — Pulse EN: J3-1 (ESP_EN) → GND rồi thả (0.5 s)
          Nếu pulse EN không ổn định: rút nguồn board rồi cắm lại
          trong khi vẫn giữ GPIO9→GND
Bước 3 — Thả jumper GPIO9
Bước 4 — Chạy lệnh upload NGAY (board đang chờ, không timeout)
```

**Dấu hiệu thành công:** `Connecting....` → `Connected to ESP32-C3`  
**Dấu hiệu thất bại:** `No serial data received` → lặp lại từ bước 1

---

## 3. Xác định COM port

Mở **Device Manager → Ports (COM & LPT)**, tìm **USB Serial Port (FTDI)**.

- Máy tại CLV (lần test cuối): **COM6**
- Laptop khác: có thể khác — xem Device Manager

Sửa `platformio.ini` cho đúng port:
```ini
upload_port  = COMx   ; ← đổi số này
monitor_port = COMx
```

---

## 4. Build & Upload

### Cách 1 — Script sẵn (khuyến nghị trên Windows)

```bat
cd firmware
build.bat     ← chỉ build
upload.bat    ← build + flash
monitor.bat   ← mở serial monitor
```

> Các script này clear `MSYSTEM` và set `PLATFORMIO_CORE_DIR=X:\` để tránh
> lỗi MAX\_PATH và xung đột git-bash. Chạy qua **cmd.exe**, không phải git-bash.

### Cách 2 — PlatformIO CLI

```bash
cd firmware
pio run -e eth01evo                           # chỉ build
pio run -e eth01evo --target upload           # build + flash (dùng port trong .ini)
pio run -e eth01evo --target upload --upload-port COM6   # chỉ định port thủ công
pio device monitor -e eth01evo               # serial monitor 115200 baud
```

---

## 5. Cấu hình upload trong platformio.ini

```ini
[env:eth01evo]
upload_port     = COM6        ; ← đổi theo máy
upload_speed    = 921600
upload_protocol = esptool
upload_flags    =
    --before=no_reset         ; bắt buộc — board không có auto-reset
    --after=no_hard_reset     ; bắt buộc — tránh RTS/DTR reset sau flash
```

**Không được bỏ 2 flag `--before` / `--after`** — nếu thiếu, esptool thử
kéo RTS/DTR để reset → fail hoàn toàn với board này.

---

## 6. Lỗi thường gặp & cách xử lý

| Lỗi | Nguyên nhân | Cách fix |
|---|---|---|
| `No serial data received` | Chưa vào boot mode / GPIO9 không chạm GND | Lặp lại boot mode procedure; thử power-cycle thay vì pulse EN |
| `Could not open COMx: Access is denied` | Serial monitor đang giữ port | Đóng ESP Decoder / PlatformIO monitor trước khi flash |
| `Could not open COMx: file not found` | Board thoát boot mode trước khi upload chạy | Vào boot mode SAU khi lệnh upload đã chạy; hoặc chạy lệnh trước rồi vào boot mode |
| `A fatal error: Failed to get PID` | FTDI chưa được nhận / driver chưa cài | Cài driver FTDI: https://ftdichip.com/drivers/d2xx-drivers/ |
| Build lỗi `MAX_PATH` (Windows) | Domain GP tắt Long Path; path `.platformio` quá sâu | Xem mục 7 bên dưới |
| `MQTT_KEEPALIVE redefined` (warning) | Defined cả ở `platformio.ini` và `config.h` | Bình thường — `config.h` (=5 s) thắng, không cần sửa |

---

## 7. Fix MAX_PATH trên Windows domain (neonuat.clubvegaming.com)

Group Policy của domain reset Long Path về disabled sau mỗi lần boot.
Workaround: `subst` ổ đĩa ảo để rút ngắn đường dẫn.

**Chạy một lần với quyền Admin (cmd.exe):**
```bat
mkdir C:\pio
subst X: C:\pio
```

**Thêm vào registry để subst tự động sau reboot:**
```
HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\DOS Devices
  Giá trị: X: = \??\C:\pio
```

Sau đó dùng `build.bat` / `upload.bat` — các script đã set `PLATFORMIO_CORE_DIR=X:\` sẵn.

**Nếu laptop khác không bị domain policy:** dùng thẳng `pio run` bình thường, không cần subst.

---

## 8. Serial Monitor

```
Port:  COMx (cùng port với upload)
Baud:  115200
```

Dùng **ESP Decoder** tab trong VS Code (extension ESP-IDF) để decode backtrace khi crash:
- ELF file: `firmware/.pio/build/eth01evo/firmware.elf`

---

## 9. Thông số máy tham chiếu (CLV working machine)

Máy tại CLV nạp fw thành công — dùng làm baseline so sánh:

| Thông số | Giá trị |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| PlatformIO Core | 6.1.19 |
| esptool | **v5.3.0** |
| Python (penv) | 3.11.7 |
| FTDI chip | FT232RL — VID `0403` PID `6001` |
| COM port | COM6 (USB Serial Port, FTDI driver) |
| Upload baud | 921600 |

### Lệnh esptool chính xác mà PlatformIO gọi

```bat
esptool.exe ^
  --before=no_reset ^
  --after=no_hard_reset ^
  --chip esp32c3 ^
  --port "COM6" ^
  --baud 921600 ^
  --before default-reset ^
  --after hard-reset ^
  write-flash -z ^
  --flash-mode dio ^
  --flash-freq 80m ^
  --flash-size detect ^
  0x0000  .pio\build\eth01evo\bootloader.bin ^
  0x8000  .pio\build\eth01evo\partitions.bin ^
  0xe000  <platformio_packages>\framework-arduinoespressif32\tools\partitions\boot_app0.bin ^
  0x10000 .pio\build\eth01evo\firmware.bin
```

> Thay `COM6` bằng port thực tế trên laptop khác.  
> `<platformio_packages>` = `%USERPROFILE%\.platformio\packages` (hoặc `X:\packages` nếu dùng subst).

### Chạy lệnh trực tiếp (bypass PlatformIO) để debug

Nếu `pio run --target upload` không báo lỗi rõ ràng, chạy esptool thẳng:

```bat
set PORT=COMx
%USERPROFILE%\.platformio\penv\Scripts\esptool.exe ^
  --before no_reset --after no_hard_reset ^
  --chip esp32c3 --port %PORT% --baud 921600 ^
  write-flash -z --flash-mode dio --flash-freq 80m --flash-size detect ^
  0x10000 .pio\build\eth01evo\firmware.bin
```

Lệnh rút gọn chỉ flash firmware.bin (nhanh hơn, dùng khi chỉ cần test):
không cần flash bootloader/partitions nếu chúng đã có trên board.

---

## 10. Tóm tắt nhanh (checklist)

- [ ] esptool **v5.3.0** (kiểm tra: `esptool.exe version`)
- [ ] FTDI chip FT232RL, driver FTDI VID 0403 / PID 6001
- [ ] FTDI cắm đúng TX→RXD0, RX→TXD0, GND→GND
- [ ] Device Manager xác nhận COMx
- [ ] `upload_port = COMx` trong `platformio.ini` (hoặc truyền `--upload-port COMx`)
- [ ] Đóng serial monitor trước khi flash
- [ ] Vào boot mode: GPIO9→GND → pulse EN → thả GPIO9
- [ ] Chạy `upload.bat` hoặc `pio run --target upload` ngay lập tức
- [ ] Xác nhận `Hash of data verified` → thành công
