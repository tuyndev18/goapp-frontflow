## BA-ORDER-001 — Khách huỷ đơn đang chờ
- Tác nhân: Customer. Điều kiện: đơn ở trạng thái PENDING.
- Bước: xác nhận huỷ. Kết quả: đơn chuyển sang CANCELLED.
- Quy tắc: lý do huỷ tối đa 500 ký tự. Lỗi: ORDER_NOT_FOUND, ORDER_CANNOT_BE_CANCELLED.

## BA-ORDER-002 — Nhân viên hỗ trợ huỷ đơn
- Tác nhân: Support agent. Kết quả: đơn chuyển sang CANCELLED.
