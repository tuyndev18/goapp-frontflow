import { describe, expect, it } from "vitest";
import { fallbackOperationId, inferSchema, parseApiMarkdown, parseOpenApi } from "../src/index.js";
import { fixture, snap } from "./helpers.js";

describe("parseApiMarkdown", () => {
  it("parses the spec §11.2 template fixture", () => {
    const { snapshot, text } = snap("api_markdown", fixture("cancel-order/api.md"));
    const { operations, issues } = parseApiMarkdown(snapshot, text);
    expect(issues).toEqual([]);
    expect(operations.map((o) => `${o.method} ${o.path} ${o.id}`)).toEqual(["POST /orders/{orderId}/cancel cancelOrder", "GET /orders/{orderId} getOrder"]);
    const cancel = operations[0]!;
    expect(cancel).toMatchObject({
      auth: "Bearer token",
      roles: ["CUSTOMER", "SUPPORT"],
      parameters: [{ name: "orderId", in: "path", type: "string", required: true }],
      requestSchema: { type: "object", properties: { reason: { type: "string" } } },
    });
    expect(cancel.responses).toEqual([
      { status: 200, schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", const: "CANCELLED" } } } },
      { status: 404, errorCode: "ORDER_NOT_FOUND" },
      { status: 409, errorCode: "ORDER_CANNOT_BE_CANCELLED" },
    ]);
    expect(cancel.sourceRefs[0]).toMatchObject({ snapshotId: snapshot.id, lineStart: 3, lineEnd: 29, section: ["Order API Contract", "POST /orders/{orderId}/cancel"] });
    expect(operations[1]!.summary).toBe("Returns the order details.");
    expect(operations[1]!.responses[0]!.schema).toMatchObject({ properties: { status: { enum: ["PENDING", "CANCELLED", "SHIPPED"] } } });
  });

  it("falls back to a camelCase operation id and parses loose error/param formats", () => {
    const md = [
      "# API",
      "## `DELETE /carts/:cartId/items/{itemId}` — Remove an item",
      "### Query parameters",
      "- `force` (boolean, optional)",
      "### Errors",
      "- ITEM_NOT_FOUND (404) — item does not exist",
      "- 403 — forbidden",
      "### Response 404",
      "```json",
      '{ "code": "CART_NOT_FOUND", "message": "string" }',
      "```",
    ].join("\n");
    const { snapshot, text } = snap("api_markdown", md);
    const { operations } = parseApiMarkdown(snapshot, text);
    const op = operations[0]!;
    expect(op.id).toBe("deleteCartsByCartIdItemsByItemId");
    expect(op.path).toBe("/carts/{cartId}/items/{itemId}");
    expect(op.summary).toBe("Remove an item");
    expect(op.parameters).toEqual([
      { name: "force", in: "query", type: "boolean", required: false },
      { name: "cartId", in: "path", required: true },
      { name: "itemId", in: "path", required: true },
    ]);
    expect(op.responses.map((r) => [r.status, r.errorCode ?? null])).toEqual([
      [403, null],
      [404, "ITEM_NOT_FOUND"],
      [404, "CART_NOT_FOUND"],
    ]);
    expect(fallbackOperationId("POST", "/orders/{orderId}/cancel")).toBe("postOrdersByOrderIdCancel");
  });

  it("reports invalid JSON examples as unparseable_operation warnings", () => {
    const { snapshot, text } = snap("api_markdown", "## GET /a\n### Response 200\n```json\n{ not json: [\n```\n");
    const { operations, issues } = parseApiMarkdown(snapshot, text);
    expect(operations).toHaveLength(1);
    expect(issues).toEqual([expect.objectContaining({ code: "unparseable_operation", severity: "warning", operationId: "getA" })]);
    expect(issues[0]!.sourceRefs[0]).toMatchObject({ lineStart: 3, lineEnd: 5 });
  });

  it("merges an embedded OpenAPI block with the Markdown description", () => {
    const md = [
      "# Order API", //1
      "## POST /orders/{orderId}/cancel", //2
      "- Allowed roles: CUSTOMER", //3
      "### Errors", //4
      "- 410 ORDER_EXPIRED", //5
      "## Machine-readable contract", //6
      "```yaml", //7
      "openapi: 3.1.0", //8
      "paths:", //9
      "  /orders/{id}/cancel:", //10
      "    post:", //11
      "      operationId: cancelOrder", //12
      "      responses:", //13
      '        "404":', //14
      "          description: not found", //15
      "          x-error-code: ORDER_NOT_FOUND", //16
      "  /orders:", //17
      "    get:", //18
      "      responses:", //19
      '        "200": { description: ok }', //20
      "```", //21
    ].join("\n");
    const { snapshot, text } = snap("api_markdown", md);
    const { operations, issues } = parseApiMarkdown(snapshot, text);
    expect(issues).toEqual([]);
    expect(operations.map((o) => o.id)).toEqual(["cancelOrder", "getOrders"]);
    expect(operations[0]).toMatchObject({ roles: ["CUSTOMER"], path: "/orders/{id}/cancel" });
    expect(operations[0]!.responses.map((r) => r.errorCode)).toEqual(["ORDER_NOT_FOUND", "ORDER_EXPIRED"]);
    expect(operations[0]!.sourceRefs.map((r) => r.lineStart)).toEqual([2, 4, 11]);
    expect(operations[1]!.sourceRefs[0]).toMatchObject({ lineStart: 18, lineEnd: 20 });
  });
});

describe("parseOpenApi", () => {
  it("parses the OpenAPI fixture with $refs, security, roles and error codes", () => {
    const { snapshot, text } = snap("openapi", fixture("cancel-order/openapi.yaml"));
    const { operations, issues } = parseOpenApi(snapshot, text);
    expect(issues).toEqual([]);
    const [cancel, get] = operations;
    expect(cancel).toMatchObject({
      id: "cancelOrder",
      method: "POST",
      path: "/orders/{orderId}/cancel",
      summary: "Cancel a pending order",
      auth: "Bearer token",
      roles: ["CUSTOMER", "SUPPORT"],
    });
    expect(cancel!.parameters).toEqual([
      { name: "orderId", in: "path", type: "string", required: true },
      { name: "reason", in: "body", type: "string", required: false },
    ]);
    expect(cancel!.responses.map((r) => [r.status, r.errorCode ?? null])).toEqual([
      [200, null],
      [404, "ORDER_NOT_FOUND"],
      [409, "ORDER_CANNOT_BE_CANCELLED"],
    ]);
    expect(cancel!.responses[0]!.schema).toMatchObject({ properties: { status: { enum: ["CANCELLED"] } } });
    expect(cancel!.sourceRefs[0]).toMatchObject({ lineStart: 12, section: ["paths", "/orders/{orderId}/cancel", "post"] });
    expect(get).toMatchObject({ id: "getOrder", roles: ["CUSTOMER", "SUPPORT"] });
    const lines = text.split("\n");
    expect(lines[cancel!.sourceRefs[0]!.lineStart - 1]!.trim()).toBe("post:");
    expect(lines[get!.sourceRefs[0]!.lineStart - 1]!.trim()).toBe("get:");
  });

  it("accepts JSON, reports missing operationIds and rejects non-OpenAPI documents", () => {
    const json = JSON.stringify({ openapi: "3.0.0", paths: { "/ping": { get: { security: [], responses: { "200": { description: "ok" } } } } } }, null, 2);
    const ok = parseOpenApi(snap("openapi", json).snapshot, json);
    expect(ok.operations).toEqual([expect.objectContaining({ id: "getPing", auth: "none" })]);
    expect(ok.issues.map((i) => [i.code, i.severity])).toEqual([["missing_id", "info"]]);

    const bad = parseOpenApi(snap("openapi", "title: not an api\n").snapshot, "title: not an api\n");
    expect(bad.operations).toEqual([]);
    expect(bad.issues.map((i) => i.code)).toEqual(["unparseable_operation"]);
    const broken = parseOpenApi(snap("openapi", "openapi: [unclosed\n").snapshot, "openapi: [unclosed\n");
    expect(broken.issues.map((i) => i.code)).toEqual(["unparseable_operation"]);
  });
});

describe("inferSchema", () => {
  it("infers types, formats, literal const and enum unions", () => {
    expect(inferSchema({ id: "uuid", n: 3, f: 1.5, ok: true, tags: ["string"], s: "PENDING | DONE", c: "DONE", free: "hello" })).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        n: { type: "integer" },
        f: { type: "number" },
        ok: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        s: { type: "string", enum: ["PENDING", "DONE"] },
        c: { type: "string", const: "DONE" },
        free: { type: "string", examples: ["hello"] },
      },
    });
  });
});
