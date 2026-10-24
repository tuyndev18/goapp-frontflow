## Kết luận
Đủ
Mọi kịch bản BA đều test được qua Cancel Order Modal và `cancelOrder`.

## Test case
- TC-BA-ORDER-001-01 (e2e): đơn PENDING → xác nhận huỷ → trạng thái CANCELLED.
- TC-BA-ORDER-001-02 (integration): đơn SHIPPED → 409 ORDER_CANNOT_BE_CANCELLED hiển thị, đơn giữ nguyên.
- TC-BA-ORDER-002-01 (e2e): nhân viên hỗ trợ huỷ đơn → CANCELLED.

## Chưa test được
Không có
