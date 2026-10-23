# Order API Contract

## POST /orders/{orderId}/cancel

- Operation ID: cancelOrder
- Authentication: Bearer token
- Allowed roles: CUSTOMER, SUPPORT

### Path parameters
- orderId: string, required

### Request body
```json
{
  "reason": "string"
}
```

### Response 200
```json
{
  "id": "string",
  "status": "CANCELLED"
}
```

### Errors
- 404 ORDER_NOT_FOUND
- 409 ORDER_CANNOT_BE_CANCELLED

## GET /orders/{orderId}

- Operation ID: getOrder
- Authentication: Bearer token
- Allowed roles: CUSTOMER, SUPPORT

Returns the order details.

### Path parameters
- orderId: string, required

### Response 200
```json
{
  "id": "string",
  "status": "PENDING | CANCELLED | SHIPPED",
  "total": 120.5
}
```

### Errors
- 404 ORDER_NOT_FOUND
