const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export interface DepEntry {
  name: string;
  version: string;
  field: (typeof DEP_FIELDS)[number];
  source: string;
}

export interface PackageJson {
  name?: string;
  scripts: Record<string, string>;
  packageManager?: string;
  workspaces?: string[];
  raw: Record<string, unknown>;
}

export function normalizePackageJson(value: unknown): PackageJson | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const scripts: Record<string, string> = {};
  if (raw.scripts && typeof raw.scripts === "object") {
    for (const [k, v] of Object.entries(raw.scripts as Record<string, unknown>)) if (typeof v === "string") scripts[k] = v;
  }
  let workspaces: string[] | undefined;
  const ws = raw.workspaces;
  if (Array.isArray(ws)) workspaces = ws.filter((w): w is string => typeof w === "string");
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    workspaces = ((ws as { packages: unknown[] }).packages).filter((w): w is string => typeof w === "string");
  }
  return {
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.packageManager === "string" ? { packageManager: raw.packageManager } : {}),
    ...(workspaces ? { workspaces } : {}),
    scripts,
    raw,
  };
}

/** Dependency lookup across package.json files with evidence strings. */
export class DepIndex {
  private readonly deps = new Map<string, DepEntry>();

  add(pkg: PackageJson, source: string): this {
    for (const field of DEP_FIELDS) {
      const block = pkg.raw[field];
      if (!block || typeof block !== "object") continue;
      for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
        if (!this.deps.has(name)) this.deps.set(name, { name, version: typeof version === "string" ? version : "*", field, source });
      }
    }
    return this;
  }

  get(name: string): DepEntry | undefined {
    return this.deps.get(name);
  }

  has(name: string): boolean {
    return this.deps.has(name);
  }

  withPrefix(prefix: string): DepEntry[] {
    return [...this.deps.values()].filter((d) => d.name.startsWith(prefix));
  }

  get size(): number {
    return this.deps.size;
  }

  static evidence(d: DepEntry): string {
    return `${d.source} ${d.field}.${d.name}@${d.version}`;
  }
}
