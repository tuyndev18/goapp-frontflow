import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "./fsx.js";
import type { SecretVault } from "./types.js";

/**
 * Secrets encrypted by the caller's cipher (Electron safeStorage: DPAPI / Keychain / libsecret)
 * in one owner-only file, rewritten atomically so a crash never leaves half a vault.
 */
export class EncryptedFileVault implements SecretVault {
  private entries: Record<string, string>;

  constructor(
    private readonly file: string,
    private readonly cipher: { encrypt(plain: string): string; decrypt(encrypted: string): string },
  ) {
    this.entries = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  }

  get(key: string): string | undefined {
    const value = this.entries[key];
    return value === undefined ? undefined : this.cipher.decrypt(value);
  }

  set(key: string, value: string): void {
    this.entries = { ...this.entries, [key]: this.cipher.encrypt(value) };
    atomicWriteFile(this.file, JSON.stringify(this.entries));
  }

  delete(key: string): boolean {
    if (!(key in this.entries)) return false;
    const { [key]: _removed, ...rest } = this.entries;
    this.entries = rest;
    atomicWriteFile(this.file, JSON.stringify(this.entries));
    return true;
  }
}
