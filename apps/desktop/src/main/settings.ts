import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { SettingsDto } from "../shared/ipc.js";

const DEFAULTS: SettingsDto = {
  rawTerminalLogs: true,
  defaultAdapterId: "claude-code",
  maxConcurrentNodes: 2,
  retentionDays: 30,
  allowArbitraryShell: false,
  interactiveAgents: true,
  goFigmaServerPath: "",
};

export class SettingsStore {
  private readonly file: string;
  private value: SettingsDto;

  constructor(dataDir: string) {
    this.file = join(dataDir, "settings.json");
    this.value = { ...DEFAULTS };
    if (existsSync(this.file)) {
      try {
        const stored = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SettingsDto> & { workspace?: unknown };
        // Older versions could run AI steps in a separate git worktree; agents now always work in the project folder.
        delete stored.workspace;
        this.value = { ...DEFAULTS, ...stored };
      } catch {
        // Corrupt settings fall back to defaults rather than blocking startup.
      }
    }
  }

  get(): SettingsDto {
    return { ...this.value };
  }

  update(patch: Partial<SettingsDto>): SettingsDto {
    this.value = { ...this.value, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.get();
  }
}

/** Credentials go to the OS vault via safeStorage, never to SQLite in plaintext (spec §22.3). */
export class SafeStorageVault {
  private readonly file: string;
  private entries: Record<string, string> = {};

  constructor(dataDir: string) {
    this.file = join(dataDir, "credentials.bin.json");
    if (existsSync(this.file)) {
      try {
        this.entries = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      } catch {
        this.entries = {};
      }
    }
  }

  get(key: string): string | undefined {
    const enc = this.entries[key];
    if (!enc || !safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  }

  set(key: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential vault is not available");
    this.entries[key] = safeStorage.encryptString(value).toString("base64");
    writeFileSync(this.file, JSON.stringify(this.entries));
  }

  delete(key: string): void {
    delete this.entries[key];
    writeFileSync(this.file, JSON.stringify(this.entries));
  }
}
