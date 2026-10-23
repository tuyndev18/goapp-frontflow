import type { SourceSnapshot, SourceSnapshotType } from "@frontflow/domain";
import { sha256 } from "@frontflow/domain";
import { DocumentError } from "./errors.js";
import { firstH1, splitLines, tokenizeMarkdown } from "./markdown.js";

export interface SnapshotInput {
  type: SourceSnapshotType;
  content: string | Uint8Array;
  sourceUri?: string;
  /** ISO timestamp; defaults to now. Not part of the snapshot id. */
  createdAt?: string;
}

export interface SnapshotResult {
  snapshot: SourceSnapshot;
  /** Normalized text (BOM stripped, LF line endings) — all line references point into this. */
  text: string;
}

function decode(bytes: Uint8Array): string {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw new DocumentError("UNSUPPORTED_ENCODING", "UTF-16 encoded documents are not supported; save the file as UTF-8.");
  }
  if (bytes.includes(0)) {
    throw new DocumentError("UNSUPPORTED_ENCODING", "Document contains NUL bytes and looks like a binary file.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (cause) {
    throw new DocumentError("UNSUPPORTED_ENCODING", "Document is not valid UTF-8.", { cause });
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000e-\u001f]/;

export function normalizeText(content: string | Uint8Array): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (content instanceof Uint8Array) text = decode(content);
  else throw new DocumentError("UNREADABLE", "Document content must be a string or a byte array.");

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (CONTROL_CHARS.test(text)) {
    throw new DocumentError("UNSUPPORTED_ENCODING", "Document contains binary control characters.");
  }
  return text.replace(/\r\n?/g, "\n");
}

/** Spec §12.1 A1 — immutable, content-addressed snapshot of an input document. */
export function snapshotDocument(input: SnapshotInput): SnapshotResult {
  if (input === null || typeof input !== "object") {
    throw new DocumentError("UNREADABLE", "Snapshot input is missing.");
  }
  if (input.content === undefined || input.content === null) {
    throw new DocumentError("UNREADABLE", "Document content is missing.");
  }
  if (typeof input.content !== "string" && input.content.length === 0) {
    throw new DocumentError("EMPTY_DOCUMENT", "Document is empty.");
  }
  const text = normalizeText(input.content);
  if (text.trim() === "") throw new DocumentError("EMPTY_DOCUMENT", "Document is empty.");

  const contentHash = sha256(text);
  const metadata: Record<string, unknown> = {
    lineCount: splitLines(text).length,
    byteLength: new TextEncoder().encode(text).length,
  };
  if (input.type !== "openapi") {
    const title = firstH1(tokenizeMarkdown(text));
    if (title) metadata.title = title;
  }

  const snapshot: SourceSnapshot = {
    id: `snap_${input.type}_${contentHash.slice(0, 12)}`,
    type: input.type,
    contentHash,
    createdAt: input.createdAt ?? new Date().toISOString(),
    metadata,
  };
  if (input.sourceUri) snapshot.sourceUri = input.sourceUri;
  return { snapshot, text };
}
