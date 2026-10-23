import { redactString } from "@frontflow/event-schema";

/** Splits a chunked text stream into lines (handles \r\n and partial tails). */
export class LineSplitter {
  private tail = "";

  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const parts = text.split(/\r?\n/);
    this.tail = parts.pop() ?? "";
    return parts;
  }

  flush(): string[] {
    const rest = this.tail;
    this.tail = "";
    return rest.length > 0 ? [rest] : [];
  }
}

/**
 * Line-buffered redaction for raw output so a secret split across two chunks
 * is still caught. Partial lines are flushed after `idleMs` or when large.
 */
export class RawStreamRedactor {
  private tail = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly sink: (redacted: string) => void,
    private readonly knownSecrets: string[] = [],
    private readonly idleMs = 150,
    private readonly maxTail = 16_384,
  ) {}

  push(chunk: string): void {
    const text = this.tail + chunk;
    const cut = text.lastIndexOf("\n");
    if (cut >= 0) {
      this.emit(text.slice(0, cut + 1));
      this.tail = text.slice(cut + 1);
    } else {
      this.tail = text;
    }
    if (this.tail.length > this.maxTail) {
      this.emit(this.tail);
      this.tail = "";
    }
    this.schedule();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.tail) this.emit(this.tail);
    this.tail = "";
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.tail) return;
    this.timer = setTimeout(() => this.flush(), this.idleMs);
    this.timer.unref?.();
  }

  private emit(text: string): void {
    if (text) this.sink(redactString(text, { knownSecrets: this.knownSecrets }));
  }
}
