# Feature: Cancel order

## Overview

Customers can cancel an order while it is still pending. Support agents can cancel on behalf of a customer.

## Actors
- Customer
- Support agent

## Requirements

### BA-ORDER-001 — Customer cancels a pending order
- Actor: Customer
- Preconditions: Order status is PENDING
- Action: Confirm cancellation
- Result: Order status becomes CANCELLED
- Errors:
  - ORDER_NOT_FOUND
  - ORDER_CANNOT_BE_CANCELLED
- Validations: Cancellation reason is at most 500 characters
- API: POST /orders/{orderId}/cancel

### BA-ORDER-002 — Customer views order details
- Actor: Customer
- Action: Open the order detail page
- Result: Order details including the current status are displayed
- Errors: ORDER_NOT_FOUND

## Acceptance criteria
- Given a PENDING order owned by the customer When the customer confirms cancellation Then the order status becomes CANCELLED (BA-ORDER-001)
- Given an order that does not exist When the customer opens BA-ORDER-002 detail page Then ORDER_NOT_FOUND is shown
