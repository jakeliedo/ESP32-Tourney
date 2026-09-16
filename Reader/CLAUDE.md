# Reader/ — đọc lệnh SAS mà một host thật gửi xuống máy slot

## Mục đích

`sas_command_reader.py` là công cụ **nghe lén thụ động (passive sniff)** dây RS232 SAS 6.02
giữa **một hệ thống SAS host thật** (không phải firmware ESP32/EVO của project chính,
xem `../CLAUDE.md`) và **một máy slot thật**. Dùng khi bạn muốn biết host đó đang thực sự
gửi xuống máy những lệnh gì — tên lệnh (Credits, AFT Transfer, Meters, Shutdown...) và vài
tham số chính, không chỉ hex thô.

Đây **không phải công cụ điều khiển** — nó không bao giờ phát (transmit) bất kỳ byte nào lên
bus, chỉ đọc và in ra. An toàn để cắm vào một bus SAS đang chạy thật mà không sợ can thiệp
vào máy hay host.

Toàn bộ bảng lệnh/CRC/exception được port trực tiếp từ firmware đã test trên máy thật của
project này (`firmware/src/sas/crc16.cpp`, `sas_commands.h`, `sas_commands.cpp`,
`sas_polling.cpp`) — không phải đoán từ tài liệu suông. Nếu firmware sau này thêm lệnh mới,
cập nhật lại `LP_NAMES`/`EXCEPTION_NAMES` trong `sas_command_reader.py` cho khớp.

## Cách chạy

```bash
pip install pyserial   # nếu chưa có
python sas_command_reader.py COM8
python sas_command_reader.py COM8 --direction machine --parity mark
python sas_command_reader.py --selftest   # kiểm tra bảng tra cứu/offset, không cần phần cứng
```

| Cờ | Mặc định | Ý nghĩa |
|---|---|---|
| `port` | (bắt buộc) | Cổng COM của adapter dùng để nghe (vd `COM8`) |
| `--baud` | `19200` | Baud rate SAS chuẩn |
| `--direction` | `host` | `host` = dây bạn tap mang tín hiệu TX của HOST (= RX của máy) — xem lệnh host gửi xuống. `machine` = dây mang TX của MÁY — xem phản hồi/exception máy trả về. Chỉ ảnh hưởng cách diễn giải frame 1-byte (General Poll vs Exception byte); frame Long Poll tự nhận diện được qua độ dài/nội dung, không phụ thuộc cờ này. |
| `--parity` | `space` | Parity cố định để giữ khung byte đúng nhịp (xem "Giới hạn đã biết" bên dưới) |
| `--selftest` | — | Chạy vài test nội bộ với frame mẫu đã biết trước ý nghĩa, không cần cổng COM thật |

## Cách đấu dây (tap)

Dùng **1 adapter USB-RS232↔TTL** (hoặc PL2303/FTDI tương tự) cắm vào PC:

- Nối **chỉ chân RX** của adapter vào đúng dây mang tín hiệu **TX của HOST** cần nghe
  (dây này chính là chân **RX phía máy slot**, vì TX bên này = RX bên kia).
- Nối GND chung giữa adapter và bus đang nghe.
- **Tuyệt đối không nối chân TX của adapter vào đâu cả** — chỉ nghe, không phát, không
  can thiệp bus thật.

**Không chắc chân nào là TX thật của host** (đừng tin nhãn in trên connector, quy ước
TX/RX theo góc nhìn thiết bị A hay B rất hay gây nhầm — bài học đã đúc kết trong
`../CLAUDE.md`, mục "Cách chẩn đoán TX/RX thật trên cổng SAS của máy"): đo điện áp hở
mạch (chưa cắm gì) trên từng chân —
- Chân ra điện áp **âm ổn định** (khoảng -5V đến -12V) dù không tải → đó là **TX thật**.
- Chân gần **0V** khi không tải → đó là **RX thật**.

## Giới hạn đã biết

- **PC UART không đọc được bit9 thật** như ESP32 firmware làm được (xem
  `sas_polling.cpp` / `uart_set_parity_for_bit9()`) — không có cách phần cứng nào trên PC để
  phân biệt tuyệt đối byte địa chỉ (bit9=1) với byte dữ liệu (bit9=0). Script suy luận ranh
  giới frame qua **khoảng lặng >10ms giữa các byte** (SAS cho phép tối đa 5ms giữa các byte
  trong cùng 1 frame) — đúng với cách `tools/sas_sniffer.py` (công cụ sniffer gốc của project,
  không có phần giải mã tên lệnh) đã làm và đã verify hoạt động trên máy thật.
- Muốn xem **cả 2 chiều** (lệnh host gửi VÀ phản hồi máy trả lời) cùng lúc: chạy **2 instance
  song song**, mỗi cái tap 1 dây riêng với `--direction` tương ứng (`host` / `machine`), rồi
  đối chiếu theo timestamp — script này không gộp 2 luồng vào 1 lần chạy.
- Giải mã tham số chi tiết chỉ áp dụng cho các lệnh **đã verify chắc chắn** offset trên máy
  thật/từ header spec của project (`0x01/0x02/0x06/0x07` Type-S, `0x1A/0x11` Credits/Coin-In,
  `0x72` AFT Transfer, `0x73` AFT Register, `0x74` AFT Lock/Status, `0x7B` Extended Validation
  Status, `0xAF` Meters — request side). Với các trường hợp khác (đặc biệt là **response** của
  `0x1B`/`0x1F`/`0x54`/`0x72`/`0x73`/`0x74`, vốn có biến thể thật khác spec sách vở, vd `0x1F`
  chỉ 24 byte thay vì 25 trên máy đã test) — script chỉ in tên lệnh + hex thô, **không đoán
  offset field** để tránh báo sai.

## Quan hệ với `tools/sas_sniffer.py`

`tools/sas_sniffer.py` (đã có sẵn trong repo trước đây) làm đúng việc bắt frame thô +
kiểm tra CRC, dùng để trả lời câu hỏi "có tín hiệu gì trên dây không" khi nghi ngờ EVO
board không đọc được máy thật. `sas_command_reader.py` ở đây dùng lại đúng cơ chế bắt
frame đó (tự chứa, không import chéo — đúng convention hiện có của các script trong
`tools/`), nhưng thêm phần còn thiếu: **dịch byte lệnh ra tên + tham số chính**, phục vụ
mục đích khác — xem một host SAS thật (không phải EVO) đang ra lệnh gì cho máy.
