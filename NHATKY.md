# Nhật ký làm việc — ESP32-Tourney

> File này ghi lại **mỗi ngày đã làm gì** (theo thứ tự thời gian), ngắn gọn.
> Khác với `CLAUDE.md` — nơi ghi các *lưu ý kỹ thuật cố định* (kiến trúc, ràng buộc,
> cách vận hành, bài học debug chi tiết). Nhật ký này chỉ cần vài dòng mỗi ngày:
> hôm nay làm gì, kết quả ra sao, việc gì còn dang dở cho ngày sau.

---

## 2026-09-08 (Thứ 3)

- Tạo file nhật ký này.
- Việc đang dang dở từ phiên debug SAS trước đó (chưa xong):
  - Đã xác nhận và sửa lỗi **đảo chiều TX/RX giữa ESP32 (GPIO18/19) ↔ V0259** (tài liệu
    CLAUDE.md ghi sai chiều — đã sửa đúng theo schematic gốc).
  - Loopback ESP32↔V0259 (cả TTL và RS232 side) đã xác nhận hoạt động **hoàn hảo**.
  - SAS đã xác nhận **enable trên port 1** ở máy thật (loại trừ nguyên nhân "chưa bật SAS").
  - Vẫn còn **im lặng hoàn toàn** khi nối vào máy slot thật, kể cả General Poll (phép
    thử cơ bản nhất, máy bắt buộc phải trả lời theo spec).
  - **Việc tiếp theo**: kiểm tra/đảo chiều dây RS232 giữa V0259 ↔ máy thật (nghi ngờ
    bị đảo TXD/RXD tương tự lỗi vừa sửa ở phía TTL).

- **🎉 THÀNH CÔNG**: Board đã được đấu vào máy slot thật tại casino (COM7). Đọc log
  xác nhận giao tiếp SAS hoạt động đúng:
  - General Poll (`81`) → máy trả lời exception `1F` ("No activity, waiting for
    player input") liên tục khi idle — hợp lệ theo Appendix A.
  - Credits (LP 0x1A) → nhận đủ 8 byte, CRC hợp lệ, credits = 0.
  - Meters (LP 0xAF) vẫn timeout — giới hạn đã biết của máy EGT này, không phải lỗi mới.
  - Đã thêm mã 0x1F vào bảng `exc_name()` trong `sas_polling.cpp` (trước đó hiện "Unknown").
  - Kết luận nguyên nhân gốc của toàn bộ chuỗi debug: **đảo chiều TX/RX giữa
    ESP32↔V0259** (tài liệu CLAUDE.md ghi sai) — sau khi sửa đúng theo schematic gốc,
    hệ thống hoạt động ổn định với máy thật.

- Test qua **control-panel API** (`POST /api/machines/01/command`) với máy thật:
  - `DISABLE` → firmware log `LP 0x01 + LP 0x07 sent`, **người dùng xác nhận máy phản
    ứng thật** (lock out).
  - `ENABLE` → firmware log `LP 0x02 + LP 0x06 sent`, máy phản ứng lại đúng.
- Power-cycle board để test LP 0x54 (Send SAS Version ID & Serial Number):
  - **Thành công**: máy trả lời `SAS v602, serial "G4"` — xác nhận máy chạy đúng
    SAS 6.02, không còn "no response" như trước khi sửa TX/RX.
  - Phát hiện thêm 1 lỗi parse nhỏ trong `sas_commands.cpp` (`sas_parse_version_serial`):
    code hiểu sai byte `length` (Table 7.15) như một "byte độ dài serial" riêng, khiến
    bị cắt mất ký tự đầu của serial number ("4" thay vì "G4"). Đã sửa đúng theo spec
    (serial bắt đầu ngay từ byte offset 6, độ dài = length−3). Build OK, **chưa flash**
    (board đang chạy sống với máy thật ở casino).

- **Rà soát luồng AFT (buy-in trên control-panel → máy slot)** theo yêu cầu người dùng,
  đối chiếu với Section 8 của SAS 6.02 gốc. Phát hiện + sửa **4 lỗi correctness**:
  1. **Registration (LP 0x73) chưa hoàn tất**: firmware trước đây chỉ gửi bước
     Initialize (code `0x00`) rồi coi là xong, dùng key toàn số 0 cho mọi LP 0x72 —
     đúng nguyên nhân gây lỗi `0x93` đã gặp 2026-09-05. Đã sửa: thêm bước 2 bắt buộc
     (code `0x01` + key non-zero do host tự chọn) theo đúng Section 8.1.
  2. **AFT_WITHDRAW dùng sai transfer_type**: code cũ dùng `0x10` ("bonus coin-out
     TỚI máy") cho việc rút tiền — không rút được gì cả. Sửa thành `0x80` (đúng
     "in-house từ máy tới host" theo Table 8.3d).
  3. **Nhầm lẫn transfer_type với amount category**: tách riêng `AFT_XFER_*` (hướng
     giao dịch thật theo Table 8.3d) khỏi `AFT_AMOUNT_*` (field BCD nào nhận tiền:
     cashable/restricted/nonrestricted) — 2 khái niệm độc lập mà code cũ gộp làm một.
  4. **AFT_WITHDRAW luôn gửi amount=0`** (backend) → không rút gì cả nếu máy có
     credits. Sửa: firmware tự đổi thành `9999999999` (sentinel "rút hết" theo
     Section 8.4) khi nhận lệnh withdraw.
  5. **Thiếu txn_id duy nhất**: buy-in/aft-in-all/aft-out-all không sinh `txn_id`,
     luôn gửi chuỗi rỗng → lần buy-in thứ 2 sẽ bị máy từ chối (trùng transaction ID,
     status `0x81`). Sửa ở backend (`mqtt-gateway.service.ts sendCommand()`): tự sinh
     UUID rút gọn 20 ký tự nếu chưa có.
  - Build firmware + type-check backend đều pass. Đã flash và test trên máy thật
    theo yêu cầu người dùng ("có máy để test").

- **Test AFT registration trên máy thật sau khi sửa (2 bước Init+Complete)**:
  status vẫn `0x80` ở bước Init — nghi ngờ `SAS_AFT_ASSET_NUMBER=67` (đoán từ máy
  khác) không khớp máy G4 hiện tại.
  - Thêm bước **Query (LP 0x73 code `0xFF`)** để firmware tự hỏi máy asset number
    thật thay vì đoán — đúng cơ chế Section 8.1.
  - Kết quả: máy báo asset number = **1040252928** (hex `3E010000`).
  - **Phát hiện lỗi byte-order nghiêm trọng**: đảo ngược hex thành `0000013E` =
    **318** — đúng con số "tournament-tracking ID (318)" đã bị từ chối trước đây!
    → Field Asset Number (và POS ID) là "binary" theo Section 2.2.3, phải encode
    **LSB-first**, nhưng code cũ ghi/đọc **MSB-first** ở cả 4 chỗ (`sas_build_lp_aft`,
    `sas_build_lp_aft_register` x2, `sas_parse_aft_register`). Đã sửa toàn bộ về
    đúng LSB-first. Build OK, chờ flash + test lại để xác nhận máy báo đúng `318`.

- **Xác nhận trên máy thật: byte-order fix hoạt động đúng** — sau khi flash, máy báo
  `asset=318` chính xác, `AFT registration OK`. Test buy-in $1 thật qua control-panel:
  người dùng xác nhận **thành công vật lý** trên máy, nhưng log lại ghi
  `AFT FAIL: status=0x40 txn=...`. Tra bảng status: `0x40` = **AFT_STATUS_PENDING**
  ("transfer pending, chưa hoàn tất") — **không phải lỗi thật**, chỉ là code cũ chưa
  xử lý đúng theo Section 8.3: sau khi nhận `0x40`, host bắt buộc phải gửi tiếp long
  poll 72 interrogation (transfer code `0xFF`) cho tới khi có status cuối cùng, nếu
  không thì transfer cycle bị coi là "vẫn đang mở" mãi mãi.

- **Phát hiện hệ quả trực tiếp của lỗi trên: AFT OUT (rút hết credit) không hoạt
  động.** Sau lần buy-in $1 trả về `0x40` ở trên, **7 lần bấm AFT OUT liên tiếp**
  (cách nhau ~25 giây) đều bị máy từ chối với `status=0xC0` ("not compatible with
  current transfer in progress"). Đối chiếu spec Section 8.3: đúng như dự đoán —
  "the host may not send another initiating long poll 72 until ... the host has
  received and acknowledged the final transfer and receipt status codes using the
  interrogation long poll 72 with transfer code FF". Vì code cũ không bao giờ gửi
  interrogation `0xFF` sau khi nhận `0x40`, máy giữ transaction buy-in $1 ở trạng
  thái "mở" vĩnh viễn từ góc nhìn của host → mọi LP 0x72 mới (kể cả AFT OUT) đều bị
  từ chối `0xC0`, bất kể asset number/registration/amount đều đúng.

- **Sửa cả 2 vấn đề trên trong `execute_aft_command()` (`sas_polling.cpp`):**
  1. Phát hiện thêm `AFT_CODE_INTERROGATE_ACK = 0xFF` (khác với `AFT_CODE_INTERROGATE
     = 0xFE` đã có sẵn) — theo spec, chỉ `0xFF` mới thực sự "acknowledge" và đóng
     transfer cycle; `0xFE` chỉ "peek" không có tác dụng phụ. Code cũ (kể cả
     `recover_pending_aft()`) dùng nhầm `0xFE` — sửa lại dùng `0xFF`.
  2. Thêm bước "flush" đầu `execute_aft_command()`: luôn gửi 1 lần interrogation-ack
     trước khi gửi initiating LP 0x72 mới, để đóng mọi transfer cycle còn treo từ
     trước (an toàn, không ảnh hưởng nếu không có gì đang treo).
  3. Khi initiating LP 0x72 trả về `0x40` (PENDING), thêm vòng lặp interrogation
     (tối đa 15 lần, cách nhau 300ms ≈ 4.5s) cho tới khi có status cuối cùng, thay
     vì log "AFT FAIL" ngay lập tức.
  - Build OK, **chưa flash lại lên máy thật** (đang chờ xác nhận từ người dùng để
    tiếp tục quy trình boot-mode/flash/power-cycle).

- **Thêm code hỏi accounting denomination thật của máy (LP 0x1F)**, theo yêu cầu
  người dùng (denom thực tế của các máy: 2¢, 5¢, 10¢, 20¢, 50¢, $1, $2, $5). Trước
  đây toàn bộ hệ thống giả định cứng "1 credit = 1 cent" (CLAUDE.md: "10000 =
  $100.00") — đúng cho máy đã test (denom code `0x01`), nhưng SAI nếu gặp máy denom
  khác (ví dụ máy `$1.00` denom, code `0x06`, thì 100 credit = $100.00 chứ không
  phải $1.00).
  - Thêm `sas_build_lp_machine_info()`/`sas_parse_machine_info()` (LP 0x1F, Table
    7.10) + bảng tra `sas_denom_code_to_value_x10000()` đầy đủ theo Table C-4
    (Appendix C, đối chiếu trực tiếp file `SAS 6.02.pdf` qua `pdftotext`), lưu giá
    trị denom dạng số nguyên "phần vạn đô-la" để tránh sai số dấu phẩy động ở các
    denom lẻ ($0.005, $0.0005...).
  - Query 1 lần khi boot (`query_machine_denom()`, tương tự `query_machine_identity()`
    cho LP 0x54), rồi dùng `credits_to_cents()` để quy đổi **mọi** giá trị "credits"
    thô của SAS (Credits LP 0x1A, Handpay LP 0x1B, Meters LP 0xAF) sang cents thật
    trước khi log/gửi MQTT — giữ nguyên convention cũ ("credits ÷ 100 = USD") cho
    backend/frontend, chỉ sửa đúng ở tầng firmware. Nếu chưa query được denom (lỗi/
    chưa kịp), fallback về hành vi cũ (coi raw = cents) để không phá vỡ máy đã test.
  - Flash lần đầu: LP 0x1F liên tục báo "response CRC/parse error" dù máy có trả lời.
    **Nguyên nhân**: máy EGT thật trả về khung LP 0x1F chỉ **24 byte**, không phải 25
    byte đúng chuẩn IGT như code giả định (`if (len < 25) return resp;`). Brute-force
    CRC qua node xác nhận khung 24-byte hợp lệ 100% (không phải lỗi truyền), lệch 1
    byte nằm sau field Denomination (khả năng field "Base %" chỉ 1 byte thay vì 2 ở
    máy này) — không ảnh hưởng vì Denomination nằm ở offset cố định [7], luôn đọc
    đúng dù tổng độ dài khung khác nhau. Sửa: check tối thiểu `len<8` (đủ để chạm
    offset 7) thay vì hardcode 25, để crc16_verify tự lo phần còn lại theo đúng độ
    dài thực nhận được.
  - Sau khi sửa, flash lại + power-cycle: log xác nhận denom = **0x01 = $0.0100/credit**
    — khớp chính xác với dữ liệu từng quan sát (100 credit = $1.00).

- **AFT OUT (rút hết) vẫn fail sau fix trên — kiểm tra log thật thấy `status=0x86`**
  ("Gaming machine unable to perform partial transfers to the host") thay vì `0xC0`
  như trước (xác nhận fix interrogation-ack ở trên đã giải quyết đúng vấn đề cũ).
  Đối chiếu Section 8.3: đây là giới hạn THẬT của máy, **spec tự thừa nhận** "some
  gaming machines may refuse to perform partial transfers even if the host specifies
  partial transfer allowed" — không phải bug framing.
  - **Sửa**: bỏ hẳn cách "amount=9999999999 + partial allowed" cho AFT OUT. Thay bằng:
    query **LP 0x74 (AFT Game Lock and Status)** trước — field "current cashable
    amount" (Table 8.2b) đã có sẵn **đúng đơn vị cents** (khác LP 0x1A dùng đơn vị
    accounting-denom) — rồi gửi **FULL transfer** (không phải partial) cho đúng số
    tiền chính xác đó. Full transfer khớp đúng số hiện có không bao giờ cần đến
    "partial" nữa, nên tránh hẳn giới hạn 0x86 của máy này.
  - Thêm `sas_build_lp_aft_lock_status()`/`sas_parse_aft_lock_status()` (LP 0x74,
    Table 8.2a/8.2b). Có log rõ máy có support partial-to-host hay không (bit1 của
    host_cashout_status) để biết trước lần sau nếu gặp máy khác.
  - Build + flash OK, xác nhận qua log thật: `AFT registration OK: asset=318` →
    denom đúng → còn AFT OUT cần test lại với code mới (đã build, đang chờ flash khi
    viết dòng này).

- **3 yêu cầu nghiệp vụ mới, đã implement (build OK, chưa flash):**
  1. **Cent lẻ trong AFT in/out phải chính xác tuyệt đối, không làm tròn.** Audit
     toàn bộ stack tìm ra 2 bug thật:
     - Control-panel (`App.tsx`) dùng `parseInt()` cho ô nhập buy-in/nạp-tất-cả →
       `"50.75"` bị cắt cụt thành `50`, mất hẳn 75 cent trước khi nhân 100. Sửa
       `parseFloat()+Math.round()` (đúng pattern đã dùng ở ô cấu hình Virtual Jackpot
       cùng file).
     - **Bug nghiêm trọng hơn**: `virtual-jackpot.service.ts` cộng dồn pool theo %
       (`pool += coin_in_delta * rate`), luôn sinh ra số có phần lẻ dưới 1 cent —
       nhưng code **luôn `Math.floor()`** khi trả thưởng/hiển thị → mỗi lần jackpot
       nổ đều trả THIẾU một phần cent thật, đúng hiện tượng "jp hit có số lẻ đến
       thập phân" người dùng mô tả. Sửa 3 chỗ (`getPool()`, số trả thưởng, số hiển
       thị broadcast) sang `Math.round()`.
     - Backend (`device.controller.ts`) đổi `Math.floor→Math.round` cho amount field
       (phòng hờ, hiện tại vô hại nhưng floor thiên về mất tiền lẻ nếu có sai số float
       từ nơi khác truyền vào).
  2. **Leaderboard tự scale theo tỷ lệ màn hình** — bug gốc: tọa độ số/hàng dùng px
     cố định đo trên canvas 1920×1080, trong khi ảnh nền dùng `background-size:cover`
     tự scale riêng theo màn hình thật → chỉ thẳng hàng đúng ở đúng 1920×1080, lệch
     ở mọi kích thước khác. Sửa: bọc toàn bộ trong 1 khối canvas cố định 1920×1080,
     dùng CSS `transform: scale()` để scale **cả khối** (ảnh nền + số) theo đúng tỷ
     lệ màn hình thật (`Math.max(vw/1920, vh/1080)`, giữ nguyên hành vi "fill+crop"
     như cover cũ) — giờ luôn thẳng hàng ở mọi độ phân giải/tỷ lệ. Toàn bộ giá trị
     `vw` cũ (font-size, kích thước vòng tròn timer/jackpot...) chuyển sang px tính
     theo canvas (hàm `pxw()`) để tránh double-scale.
  3. **Tọa độ cho ảnh nền khác nhau** — externalize toàn bộ ROW/COL_NAME/COL_WIN/TIMER
     vào `electron/config.json` (`layout` key, đọc qua `window.__config__.layout`,
     merge với default trong code). Trả lời câu hỏi người dùng: **có, vẫn cần khai
     báo tọa độ 1 lần cho mỗi ảnh nền khác nhau** (không tránh được, mỗi ảnh thiết kế
     khác nhau) — nhưng giờ chỉ cần sửa file config, không cần sửa code/build lại;
     và nhờ fix #2, khai báo đó chỉ cần làm **1 lần cho mỗi ảnh**, tự động đúng trên
     mọi kích thước màn hình.
  - Cả 2 frontend build/type-check sạch. **Chưa kiểm tra bằng mắt trong trình duyệt.**

- **2 yêu cầu nghiệp vụ nữa, đã implement (build OK, chưa flash):**
  1. **Máy đang DISABLED thì không cho AFT OUT.** Chặn ở 2 lớp: firmware
     (`sas_polling_task`'s `CMD_AFT_WITHDRAW` handler, check `s_state ==
     SLOT_STATE_DISABLED` — lớp thật sự có thẩm quyền vì đây là trạng thái phần cứng
     real-time) và backend (`device.controller.ts`, check DB status trước khi gửi
     MQTT — để phản hồi ngay, tránh round-trip vô ích). `aft-out-all` cũng loại máy
     DISABLED khỏi danh sách xử lý, và không còn reset điểm leaderboard của máy đó
     về 0 (trước đây `pushLeaderboard({resetToZero:true})` reset TẤT CẢ máy trong
     tournament vô điều kiện — sửa thêm tham số `resetIds` để chỉ reset đúng những
     máy thực sự bị rút tiền).
  2. **Khóa in/cashout ticket khi hệ thống EVO đang chạy — có làm được, dùng đúng cơ
     chế chuẩn SAS**: Long Poll **0x7B (Extended Validation Status)**, Section 15.2,
     Table 15.2c — tồn tại sẵn trong spec chính là để host bật/tắt "dùng máy in làm
     thiết bị cashout". Thêm `sas_build_lp_validation_status()`/
     `sas_parse_validation_status()`, gọi 1 lần lúc boot (`configure_ticket_lockdown()`)
     tắt 3 bit: in ticket cashable (bit0, theo spec đã bao gồm cả restricted), in
     ticket restricted (bit3, dự phòng), và nhận ticket-in/redemption (bit5) — giữ
     nguyên bit1/bit2 (in/validate handpay receipt, không liên quan yêu cầu này).
     **Lưu ý quan trọng**: đây là ghi cấu hình bền vững trên máy, KHÔNG tự động phục
     hồi khi board mất điện/ngắt kết nối — muốn trả máy về chế độ ticket bình thường
     cần gửi lại LP 0x7B với các bit đó = 1 (hoặc qua menu operator nếu máy hỗ trợ).
  - Đã flash lên máy thật (2026-09-08), **chưa xác nhận kết quả test qua log** —
    đang chờ đọc log sau power-cycle.

- **Thêm 2 LED báo hiệu hoạt động** (D1 GPIO5 đỏ = serial SAS, D2 GPIO2 xanh = mạng/MQTT),
  theo yêu cầu người dùng muốn thấy trực quan khi EVO đang giao tiếp. Module mới
  `src/led_indicator.h/.cpp`. Cơ chế: **toggle mỗi sự kiện thật** (không phải bật rồi
  hẹn giờ tắt) — nối vào `sas_send_byte()` + 2 điểm đọc byte thành công trong
  `sas_polling.cpp` (mọi byte TX/RX thật trên UART SAS, không phụ thuộc cờ
  `SAS_LOG_RAW_FRAMES`), và vào `serialize_and_publish()`/`on_message()` trong
  `mqtt_client.cpp` (mọi publish/nhận MQTT thật). Build OK, chưa flash.

---
