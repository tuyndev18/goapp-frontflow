export type DocumentErrorCode = "EMPTY_DOCUMENT" | "UNSUPPORTED_ENCODING" | "UNREADABLE";

/** Raised when a source document cannot be snapshotted (spec §12.1 A1 failure conditions). */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;

  constructor(code: DocumentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentError";
    this.code = code;
  }
}

export class TraceabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceabilityError";
  }
}
