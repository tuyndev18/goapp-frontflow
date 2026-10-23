import { describe, expect, it } from "vitest";
import { DocumentError, snapshotDocument, tokenizeMarkdown } from "../src/index.js";
import type { MdList } from "../src/index.js";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DocumentError ? error.code : "OTHER";
  }
  return undefined;
}

describe("snapshotDocument", () => {
  it("produces a deterministic content-addressed id and metadata", () => {
    const a = snapshotDocument({ type: "ba_markdown", content: "# Cancel order\n\nBody\n", sourceUri: "ba.md", createdAt: "2026-01-01T00:00:00Z" });
    const b = snapshotDocument({ type: "ba_markdown", content: "# Cancel order\n\nBody\n" });
    expect(a.snapshot.id).toBe(b.snapshot.id);
    expect(a.snapshot.id).toMatch(/^snap_ba_markdown_[0-9a-f]{12}$/);
    expect(a.snapshot.contentHash).toHaveLength(64);
    expect(a.snapshot.sourceUri).toBe("ba.md");
    expect(a.snapshot.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(a.snapshot.metadata).toEqual({ lineCount: 3, byteLength: 21, title: "Cancel order" });
    expect(snapshotDocument({ type: "api_markdown", content: "# Cancel order\n\nBody\n" }).snapshot.id).not.toBe(a.snapshot.id);
  });

  it("strips the BOM and normalizes CRLF so equivalent files hash identically", () => {
    const unix = snapshotDocument({ type: "ba_markdown", content: "# T\nline\n" });
    const windows = snapshotDocument({ type: "ba_markdown", content: "﻿# T\r\nline\r\n" });
    const bytes = snapshotDocument({ type: "ba_markdown", content: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# T\r\nline\r\n")]) });
    expect(windows.text).toBe("# T\nline\n");
    expect(windows.snapshot.id).toBe(unix.snapshot.id);
    expect(bytes.snapshot.id).toBe(unix.snapshot.id);
  });

  it("rejects empty, binary, non-UTF-8 and unreadable content with typed errors", () => {
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: "" }))).toBe("EMPTY_DOCUMENT");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: " \n\t\r\n" }))).toBe("EMPTY_DOCUMENT");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: new Uint8Array() }))).toBe("EMPTY_DOCUMENT");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: new Uint8Array([0x23, 0xc3, 0x28]) }))).toBe("UNSUPPORTED_ENCODING");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) }))).toBe(
      "UNSUPPORTED_ENCODING",
    );
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: new Uint8Array([0xff, 0xfe, 0x23, 0x00]) }))).toBe("UNSUPPORTED_ENCODING");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: "abc\u0000def" }))).toBe("UNSUPPORTED_ENCODING");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: 42 as unknown as string }))).toBe("UNREADABLE");
    expect(errorCode(() => snapshotDocument({ type: "ba_markdown", content: undefined as unknown as string }))).toBe("UNREADABLE");
  });
});

describe("tokenizeMarkdown", () => {
  const doc = [
    "# Title", //1
    "", //2
    "## Section A", //3
    "Para line one", //4
    "continues here.", //5
    "", //6
    "- top", //7
    "  - child", //8
    "    - grandchild", //9
    "- second", //10
    "", //11
    "```json", //12
    "# not a heading", //13
    "```", //14
    "### Sub", //15
    "1. ordered", //16
  ].join("\n");

  it("extracts headings with paths, nested lists, fenced code and paragraphs with line numbers", () => {
    const blocks = tokenizeMarkdown(doc);
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "heading", "paragraph", "list", "code", "heading", "list"]);
    const sub = blocks[5]!;
    expect(sub.kind === "heading" && sub.section).toEqual(["Title", "Section A", "Sub"]);
    const para = blocks[2]!;
    expect(para).toMatchObject({ kind: "paragraph", text: "Para line one continues here.", lineStart: 4, lineEnd: 5, section: ["Title", "Section A"] });
    const list = blocks[3] as MdList;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ text: "top", lineStart: 7, lineEnd: 9 });
    expect(list.items[0]!.children[0]!.children[0]).toMatchObject({ text: "grandchild", lineStart: 9 });
    expect(blocks[4]).toMatchObject({ kind: "code", lang: "json", content: "# not a heading", lineStart: 12, lineEnd: 14 });
    expect(blocks[6]).toMatchObject({ kind: "list", section: ["Title", "Section A", "Sub"] });
  });
});
