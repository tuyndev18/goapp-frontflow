/**
 * Secret storage (spec §22.3): credentials never go into SQLite. The Electron main process
 * implements this with `safeStorage` (OS keychain / DPAPI / libsecret-backed encryption) and
 * keeps only ciphertext on disk. Keys are namespaced identifiers, e.g. "figma:pairing:{projectId}".
 */
export interface CredentialVault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Test/dev vault. Process memory only. */
export class InMemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    if (!key) throw new Error("Credential key must not be empty");
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  /** Current secret values, e.g. to feed ArtifactStore's knownSecrets redaction. */
  knownSecrets(): string[] {
    return [...this.values.values()];
  }
}
