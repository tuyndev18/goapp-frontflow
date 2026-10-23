import { REDACTED, scrubEnv } from "@frontflow/event-schema";

/** Non-secret variables a CLI needs to locate itself, its config and temp dirs. */
export const MINIMAL_ENV_KEYS: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "USERNAME",
  "USERDOMAIN",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
];

export type InheritEnv = "minimal" | "all" | "none";

export interface BuildEnvOptions {
  inherit?: InheritEnv;
  /** Additional parent variables to inherit on top of the minimal set. */
  extraInheritKeys?: readonly string[];
  /** Explicit variables (including secrets) merged last. */
  env?: Record<string, string>;
  source?: NodeJS.ProcessEnv;
}

/**
 * Builds a child env from a minimal allow-list of the parent env plus the
 * explicit `env`. Secrets must arrive through `env`, never argv (spec §9.3).
 */
export function buildChildEnv(options: BuildEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const inherit = options.inherit ?? "minimal";
  const out: Record<string, string> = {};
  if (inherit === "all") {
    for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v;
  } else if (inherit === "minimal") {
    const allow = new Set([...MINIMAL_ENV_KEYS, ...(options.extraInheritKeys ?? [])].map((k) => k.toUpperCase()));
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined) continue;
      const upper = k.toUpperCase();
      if (allow.has(upper) || upper.startsWith("XDG_")) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(options.env ?? {})) {
    // Windows env names are case-insensitive: drop a differently-cased duplicate.
    if (process.platform === "win32") {
      for (const existing of Object.keys(out)) {
        if (existing !== k && existing.toUpperCase() === k.toUpperCase()) delete out[existing];
      }
    }
    out[k] = v;
  }
  return out;
}

/** Values of secret-looking variables, used as literal redaction targets. */
export function secretValuesOf(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const scrubbed = scrubEnv(env);
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (scrubbed[k] === REDACTED && v.length >= 4) out.push(v);
  }
  return out;
}
