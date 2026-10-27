## Chức năng
### BA-ORDER-001 — Khách huỷ đơn đang chờ
- Quy tắc nghiệp vụ: chỉ huỷ được đơn PENDING; lý do huỷ tối đa 500 ký tự.
- Thao tác → kết quả: xác nhận huỷ → đơn chuyển sang CANCELLED.
- Ngoại lệ: ORDER_NOT_FOUND, ORDER_CANNOT_BE_CANCELLED.
- Tiêu chí kiểm chứng: đơn PENDING huỷ xong hiển thị CANCELLED.

### BA-ORDER-002 — Nhân viên hỗ trợ huỷ đơn
- Quy tắc nghiệp vụ: Support agent được huỷ đơn của khách.
- Thao tác → kết quả: đơn chuyển sang CANCELLED.

## Luồng đầy đủ
1. Customer → BA-ORDER-001 → thấy đơn CANCELLED.
2. Support agent → BA-ORDER-002 → thấy đơn CANCELLED.

## Chưa rõ
Không có
