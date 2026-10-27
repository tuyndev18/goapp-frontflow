## Kết luận
Đủ
Mọi quy tắc và luồng huỷ đơn đều có test.

## Unit Test
- TC-BA-ORDER-001-01: lý do 501 ký tự → báo lỗi, không gửi yêu cầu huỷ.
- TC-BA-ORDER-001-02: đơn SHIPPED → 409 ORDER_CANNOT_BE_CANCELLED hiển thị, đơn giữ nguyên.
- TC-BA-ORDER-002-01: nhân viên hỗ trợ thấy nút huỷ đơn của khách.

## E2E Autotest
- E2E-01: khách huỷ đơn PENDING → CANCELLED (BA-ORDER-001).
- E2E-02: nhân viên hỗ trợ huỷ đơn → CANCELLED (BA-ORDER-002).
