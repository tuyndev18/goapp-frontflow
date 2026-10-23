# Feature: Order management

## Actors
- Customer
- Support agent
- Warehouse staff

## Requirements

### BA-ORDER-001 — Customer cancels a pending order
- Actor: Customer
- Preconditions: Order status is PENDING
- Action: Confirm cancellation
- Result: Order status becomes CANCELLED
- Errors:
  - ORDER_NOT_FOUND
  - ORDER_CANNOT_BE_CANCELLED

### BA-ORDER-002 — Support agent refunds a delivered order
- Actor: Support agent
- Preconditions: Order status is DELIVERED
- Action: Issue a refund for the order
- Result: Order status becomes REFUNDED
- Errors: REFUND_NOT_ALLOWED

### BA-ORDER-003 — Customer changes the delivery address
- Actor: Customer
- Preconditions: Order status is PENDING
- Action: Submit a new delivery address
- Result: The new delivery address is saved and displayed on the order
- Errors: ADDRESS_INVALID; ORDER_ALREADY_SHIPPED
- Validations: Postal code is required

### BA-ORDER-004 — Warehouse staff marks an order as shipped
- Actor: Warehouse staff
- Preconditions: Order status is PACKED
- Action: Mark the order as shipped
- Result: Order status becomes SHIPPED
- Errors: ORDER_NOT_FOUND

### BA-ORDER-005 — Customer filters the order list by status
- Tác nhân: Customer
- Hành động: Choose a status in the filter dropdown
- Kết quả: Only orders with the chosen status are shown
- Ghi chú: Client-side only — không cần API, the list is already loaded.

### Order history
The customer should be able to see past orders sorted by date.
