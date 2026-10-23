# Order API Contract v2

## POST /orders/{orderId}/cancel

- Operation ID: cancelOrder
- Authentication: Bearer token
- Allowed roles: CUSTOMER, SUPPORT

### Response 200
```json
{
  "id": "string",
  "status": "CANCELED"
}
```

### Errors
- 404 ORDER_NOT_FOUND
- 409 ORDER_CANNOT_BE_CANCELLED

## PUT /orders/{orderId}/delivery-address

- Operation ID: updateDeliveryAddress
- Authentication: Bearer token
- Allowed roles: CUSTOMER

### Request body
- street: string, required
- postalCode: string, required

### Response 200
```json
{
  "id": "string",
  "deliveryAddress": { "street": "string", "postalCode": "string" }
}
```

### Errors
- 400 ADDRESS_INVALID
- 404 ORDER_NOT_FOUND

## POST /orders/{orderId}/ship

- Operation ID: shipOrder
- Authentication: Bearer token
- Allowed roles: ADMIN

### Response 200
```json
{ "id": "string", "status": "SHIPPED" }
```

### Errors
- 404 ORDER_NOT_FOUND

## GET /orders

- Operation ID: listOrders
- Authentication: Bearer token
- Allowed roles: CUSTOMER, SUPPORT

### Query parameters
- status: string, optional

### Response 200
```json
[{ "id": "string", "status": "PENDING | CANCELED | SHIPPED" }]
```
