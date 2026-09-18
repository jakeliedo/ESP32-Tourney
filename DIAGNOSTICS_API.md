# API backend ESP32-Tourney — tài liệu cho dự án chẩn đoán/điều khiển riêng biệt

> File này mô tả **API REST hiện có** của backend NestJS (`:3000`) trong repo `ESP32-Tourney`, dùng làm
> spec bàn giao cho một dự án **hoàn toàn riêng biệt** (thiết bị chẩn đoán cầm tay/máy tính) — dự án đó
> chỉ cần gọi các endpoint dưới đây, không cần tự nói chuyện giao thức SAS.
>
> Nội dung lấy trực tiếp từ code hiện tại ngày 2026-09-18 (`backend/src/device-gateway/mqtt-gateway.service.ts`,
> `backend/src/database/entities/machine.entity.ts`, `backend/src/device-gateway/device.controller.ts`,
> `backend/src/database/machine.controller.ts`). Không có field/lệnh nào trong tài liệu này là suy đoán —
> nếu sau này thêm field/lệnh mới ở backend, cập nhật lại file này cùng lúc.

---

## 1. Tổng quan

- **Base URL**: `http://<ip-máy-chạy-backend>:3000` (mạng nội bộ, cùng LAN với board ESP32 + Mosquitto).
- **Không có authentication** — mọi request đều được chấp nhận, không cần token/API key. Vì vậy dự án
  mới chỉ nên chạy trong mạng nội bộ tin cậy, không expose ra internet.
- **Content-Type**: `application/json` cho mọi request có body.
- **Quy ước `null`**: với các field "diagnostics" (liệt kê ở mục 2), `null` nghĩa là **"chưa từng đọc
  được từ máy"**, KHÔNG phải giá trị thật là `0`/`false`. Một số field (vd `cash_out_limit_cents`) có
  thể hợp lệ = `0` thật (xem mục 5 "Giới hạn đã biết").
- **Số tiền**: mọi field `*_cents` là số nguyên đơn vị cent (chia 100 ra USD). `coin_in`/`coin_out` là
  bigint Postgres nên trả về dạng **chuỗi số** trong JSON (vd `"4901700"`), không phải number — client
  cần tự `parseInt`/`Number()` khi tính toán.
- **Đơn vị thời gian**: `created_at`/`updated_at` là ISO 8601 UTC string.

---

## 2. `GET /api/machines`

Trả về mảng toàn bộ máy đã từng kết nối (không lọc theo trạng thái), sắp xếp theo `machine_id` tăng dần.
Đây chính là toàn bộ cột của `MachineEntity` — không có field nào bị ẩn.

### Ví dụ response thật (gọi trực tiếp lúc viết tài liệu này)

```json
[
  {
    "machine_id": "01",
    "display_name": "Ricky Martin",
    "ip_address": null,
    "status": "offline",
    "credits": 0,
    "coin_in": "4901700",
    "coin_out": "4355550",
    "tournament_id": null,
    "cash_out_limit_cents": "0",
    "aft_transfer_limit_cents": "4000000",
    "enabled_features": 118196,
    "rte_guard_ok": true,
    "bill_config_ok": false,
    "door_open": false,
    "last_cycle_overrun_ms": 46323,
    "serial_number": "G4",
    "sas_version": "602",
    "denom_code": 1,
    "denom_value_x10000": "100",
    "asset_number": "318",
    "aft_registered": false,
    "bv_enabled": true,
    "printer_enabled": true,
    "created_at": "2026-09-02T12:59:30.536Z",
    "updated_at": "2026-09-18T03:54:33.772Z"
  }
]
```
(`status: "offline"` ở mẫu trên chỉ phản ánh đúng lúc gọi thử — board có thể đang mất kết nối MQTT tạm
thời, không phải lỗi field.)

### Bảng field đầy đủ

| Field | Kiểu JSON | Ý nghĩa | Nguồn SAS | Tốc độ cập nhật |
|---|---|---|---|---|
| `machine_id` | string | ID máy (khoá chính, do NVS firmware cấp lúc provision) | — | tĩnh |
| `display_name` | string | Tên hiển thị, đặt qua `PATCH /api/machines/:id` | — | thủ công |
| `ip_address` | string\|null | Chưa thấy nơi nào ghi giá trị này trong code hiện tại — luôn `null` trên thực tế | — | — |
| `status` | `"online"\|"offline"\|"playing"\|"locked"\|"handpay"\|"disabled"` | Trạng thái suy ra từ state máy + MQTT LWT (`casino/machine/{id}/status`) | LP General Poll + kết nối MQTT | mỗi telemetry (~200ms-1s) |
| `credits` | number | Credit hiện tại, **đơn vị cent** (chia 100 ra USD) | LP 0x1A | ~200ms |
| `coin_in` | string (bigint) | Tổng coin-in tích lũy, đơn vị cent | LP 0xAF hoặc LP 0x11 (máy nào trả lời được), fallback suy luận từ delta credit | ~1s |
| `coin_out` | string (bigint) | Tổng coin-out tích lũy, đơn vị cent | LP 0xAF | ~1s |
| `tournament_id` | number\|null | Tournament đang gán (nếu có) | — | — |
| `cash_out_limit_cents` | string (bigint)\|null | **Giới hạn HOPPER** (xu vật lý) máy có thể trả không cần handpay — Table 7.16. Thường = `0` trên máy TITO không hopper → **KHÔNG phải giới hạn AFT thật**, xem `aft_transfer_limit_cents` | LP 0xA4 | boot + ~5 phút + `REFRESH_DIAGNOSTICS` |
| `aft_transfer_limit_cents` | string (bigint)\|null | **Giới hạn AFT thật** — số tiền tối đa có thể chuyển vào credit meter bằng 1 lần AFT transfer trước khi bị từ chối status `0x84` | LP 0x74 | boot + ~5 phút + `REFRESH_DIAGNOSTICS` |
| `enabled_features` | number\|null | Bitmask 24-bit các tính năng SAS máy hỗ trợ (AFT, ticket redemption, 40ms poll rate...) — xem source `frontend/diagnostics/src/App.tsx` (`FEATURE_BITS`) để giải mã từng bit | LP 0xA0 | boot + ~5 phút + `REFRESH_DIAGNOSTICS` |
| `rte_guard_ok` | boolean\|null | Máy đã ACK lệnh tắt Real Time Event reporting chưa (bắt buộc OFF vì codebase không parse được format RTE) | LP 0x0E | boot + ~5 phút + `REFRESH_DIAGNOSTICS` |
| `bill_config_ok` | boolean\|null | Lần ghi LP 0x08 (giữ bill validator enable liên tục) gần nhất có được ACK không | LP 0x08 | mỗi lần ENABLE/ENABLE_BV |
| `door_open` | boolean\|null | Cửa máy đang mở hay không (gộp cả Slot/Drop/Card-cage/Cashbox/Belly door — không phân biệt loại cửa) | Exception 0x11/0x13/0x15/0x19/0x1B/0x1D (mở) và cặp đóng tương ứng | ngay khi đổi trạng thái |
| `last_cycle_overrun_ms` | number\|null | Chu kỳ General Poll (ngân sách 40ms) gần nhất bị vượt bao nhiêu ms — 0 = không vượt kể từ lần báo cáo trước. Chỉ mang tính quan sát, không phải lỗi giao dịch | đo nội bộ firmware | mỗi ~40ms, report-and-clear |
| `serial_number` | string\|null | Số serial thật của máy (LP 0x54) — dùng để xác nhận board đang đấu đúng máy vật lý nào | LP 0x54 | 1 lần lúc boot |
| `sas_version` | string\|null | Phiên bản SAS máy hỗ trợ (vd `"602"`) | LP 0x54 | 1 lần lúc boot |
| `denom_code` | number\|null | Mã mệnh giá kế toán theo Table C-4 (vd `1` = $0.01/credit) | LP 0x1F | 1 lần lúc boot |
| `denom_value_x10000` | string (bigint)\|null | Giá trị mệnh giá, đơn vị "phần vạn đô-la" (chia 10000 ra USD/credit) | LP 0x1F | 1 lần lúc boot |
| `asset_number` | string (bigint)\|null | Asset number cấu hình trên máy (LP 0x73) — dùng cho AFT registration | LP 0x73 | boot + ~10s |
| `aft_registered` | boolean\|null | Đã hoàn tất đăng ký AFT 2 bước (Init+Complete) với máy chưa | LP 0x73 | khi có giao dịch AFT đầu tiên |
| `bv_enabled` | boolean\|null | Bill validator đang bật hay tắt (ACK thật từ máy, không phải "vừa gửi lệnh") | LP 0x06/0x07 | mỗi lần đổi |
| `printer_enabled` | boolean\|null | Ticket printer/cashout đang cho phép hay bị khoá | LP 0x7B | mỗi lần đổi |
| `created_at` / `updated_at` | ISO string | Thời điểm tạo bản ghi / lần ghi DB gần nhất | — | — |

---

## 3. `GET /api/machines/logs?severity=all|abnormal`

Trả về mảng log gộp từ TẤT CẢ máy (mỗi máy tự cap tối đa 12 dòng gần nhất/loại), sắp xếp theo `ts` tăng dần.

```json
[
  {
    "machineId": "01",
    "ts": 1789703644961,
    "severity": "info",
    "code": "POLL_CYCLE_OVERRUN",
    "message": "General-poll cycle overran by 46323ms (budget 40ms)"
  }
]
```

- `ts`: epoch milliseconds.
- `severity`: `"info"` hoặc `"abnormal"`.
- `code`: mã sự kiện — các giá trị hiện có: `DOOR_OPEN`/`DOOR_CLOSE`, `MACHINE_DISABLED`/`MACHINE_ENABLED`,
  `BV_ENABLED`/`BV_DISABLED`, `PRINTER_ENABLED`/`PRINTER_DISABLED`, `FEATURE_UNSUPPORTED`,
  `CASH_OUT_LIMIT_LOW` (chỉ bật nếu `.env` có `MIN_CASH_OUT_LIMIT_CENTS>0`), `RTE_DISABLE_FAILED`,
  `BILL_CONFIG_WRITE_FAILED`, `AFT_BLOCKED_HARDWARE` (giao dịch AFT bị chặn vì cửa mở/tilt/disabled —
  status `0x87`), `AFT_OVER_LIMIT` (vượt `aft_transfer_limit_cents`, status `0x84`), `POLL_CYCLE_OVERRUN`.
- Không nhận `limit` query param — mỗi máy đã tự giới hạn 12 dòng sẵn ở tầng lưu trữ.

---

## 4. `POST /api/machines/:id/command`

Body: `{ "type": "<một trong 11 giá trị dưới>", "amount"?: number, "txn_id"?: string }`

**Không có validate/whitelist ở backend** — `type` gửi sai chính tả hay giá trị lạ vẫn được forward
nguyên văn lên MQTT (`casino/machine/{id}/commands`), firmware chỉ log "Unknown command type" và không
làm gì. Client mới **nên tự giới hạn đúng 11 giá trị** dưới đây.

| `type` | `amount` | Hiệu ứng |
|---|---|---|
| `AFT_PUMP` | bắt buộc, đơn vị cent | Nạp tiền vào máy qua AFT. Backend tự cộng `credits` trong DB + đẩy leaderboard ngay (không đợi telemetry echo). `txn_id` tự sinh nếu không truyền. |
| `AFT_WITHDRAW` | bỏ qua (luôn rút hết) | Rút toàn bộ credit hiện có qua AFT. **Bị backend chặn (trả `{ok:false, error:'machine is disabled'}`) nếu máy đang `status=disabled`** — không gửi lên MQTT trong trường hợp đó. |
| `LOCK` | — | LP 0x01 Shutdown (khoá chơi, không tắt bill/printer) |
| `UNLOCK` | — | LP 0x02 Startup |
| `DISABLE` | — | LP 0x01 + LP 0x07 (khoá chơi + tắt bill acceptor). Backend set `status=disabled` ngay. |
| `ENABLE` | — | LP 0x02 + LP 0x06 (+ LP 0x08 giữ bill enable liên tục). Backend set `status=online` ngay. |
| `ENABLE_BV` | — | Chỉ LP 0x06 (không đụng Shutdown/Startup) |
| `DISABLE_BV` | — | Chỉ LP 0x07 |
| `ENABLE_PRINTER` | — | LP 0x7B, mở lại ticket cashout/redemption |
| `DISABLE_PRINTER` | — | LP 0x7B, khoá ticket cashout/redemption |
| `REFRESH_DIAGNOSTICS` | — | Ép query lại ngay LP 0xA0/0xA4/0x74 + re-assert LP 0x0E OFF, không cần đợi chu kỳ tự động ~5 phút |

Response luôn `{ "ok": true }` (trừ case `AFT_WITHDRAW` bị chặn ở trên), **không đợi máy trả lời thật** —
đây chỉ là xác nhận "đã gửi lệnh lên MQTT", kết quả thật phải đọc lại qua `GET /api/machines` sau đó
(field tương ứng sẽ đổi khi telemetry echo về) hoặc qua `GET /api/machines/logs`.

Ngoài ra còn `PATCH /api/machines/:id` với body `{"display_name": "..."}` để đổi tên hiển thị.

---

## 5. Khuyến nghị polling

- `GET /api/machines`: gọi mỗi **3-4 giây** là hợp lý (đúng cadence `frontend/diagnostics` hiện đang dùng) —
  đây chỉ là REST đọc DB, không đụng gì tới bus SAS nên gọi dày không ảnh hưởng máy thật.
- Các field "chậm" (`enabled_features`, `cash_out_limit_cents`, `aft_transfer_limit_cents`, `rte_guard_ok`)
  chỉ tự làm mới mỗi ~5 phút — nếu cần dữ liệu mới ngay lập tức (vd vừa vào màn hình chọn máy), **gọi
  `POST .../command {type:'REFRESH_DIAGNOSTICS'}` trước rồi đợi 1-2 giây** trước khi đọc lại `GET /api/machines`.
- Các field "nhanh" (`credits`, `coin_in`, `coin_out`, `status`, `door_open`) tự cập nhật liên tục, không
  cần thao tác gì thêm.

---

## 6. Giới hạn đã biết (để không mất công dò lại)

- **`cash_out_limit_cents` không phải giới hạn AFT.** Theo đúng spec SAS 6.02 Table 7.16, đây là giới hạn
  trả bằng **hopper xu vật lý** — máy TITO hiện đại không có hopper sẽ hợp lệ trả về `0`. Muốn biết "trả
  AFT bao nhiêu thì bị từ chối" phải dùng `aft_transfer_limit_cents`.
- **Không có cách nào qua SAS để đọc "giới hạn in ticket"** hay ngưỡng handpay theo luật (kiểu $1,200
  W-2G) — SAS 6.02 mô tả đây là giá trị **cấu hình trực tiếp trên máy qua audit menu**, không có Long
  Poll nào cho host đọc lại. Chỉ biết được **gián tiếp, sau khi đã xảy ra**: gửi thử `AFT_PUMP`/`AFT_WITHDRAW`
  và xem `GET /api/machines/logs` có ra `AFT_BLOCKED_HARDWARE` (status `0x87`, thường do cửa mở/tilt/
  disabled/đang cashout) hay `AFT_OVER_LIMIT` (status `0x84`) hay không.
- **`ip_address` luôn `null`** trong bản hiện tại — không có chỗ nào trong code ghi giá trị này.
- Không có WebSocket cho app chẩn đoán mới — `frontend/diagnostics` (app hiện có trong repo, không phải
  dự án bạn sắp tạo) cố tình chỉ dùng REST polling để giữ độc lập với `control-panel`/`leaderboard`
  (2 app kia mới dùng Socket.IO qua `/leaderboard` namespace, không liên quan tới các field trên).
