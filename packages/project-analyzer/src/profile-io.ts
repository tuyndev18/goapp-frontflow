import { parse, stringify } from "yaml";
import type { DetectedValue, ProjectCommands, ProjectProfile, QualityGateRequirement } from "@frontflow/domain";

export class ProfileFormatError extends Error {
  override readonly name = "ProfileFormatError";
}

const SCALAR_FIELDS = ["framework", "language", "packageManager", "uiLibrary", "apiClient", "stateManagement"] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];

/** Serializes a profile in the §10.2 layout. Detection metadata goes under `detection` unless disabled. */
export function profileToYaml(profile: ProjectProfile, options: { includeDetection?: boolean } = {}): string {
  const doc: Record<string, unknown> = {
    schemaVersion: profile.schemaVersion,
    projectId: profile.projectId,
    rootPath: profile.rootPath,
  };
  for (const f of SCALAR_FIELDS) if (profile[f] !== undefined) doc[f] = profile[f];
  doc.testFrameworks = profile.testFrameworks;
  doc.commands = stripUndefined(profile.commands);
  doc.qualityGates = profile.qualityGates;
  doc.git = profile.git;
  doc.conventionDocs = profile.conventionDocs;
  if (options.includeDetection !== false && Object.keys(profile.detection).length) doc.detection = profile.detection;
  return stringify(doc, { lineWidth: 0 });
}

export function profileFromYaml(text: string): ProjectProfile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ProfileFormatError(`invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) throw new ProfileFormatError("profile must be a YAML mapping");
  if (raw.schemaVersion !== 1) throw new ProfileFormatError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
  const projectId = requireString(raw, "projectId");
  const rootPath = requireString(raw, "rootPath");

  const profile: ProjectProfile = {
    schemaVersion: 1,
    projectId,
    rootPath,
    testFrameworks: stringArray(raw, "testFrameworks"),
    commands: stringRecord(raw, "commands") as ProjectCommands,
    qualityGates: stringRecord(raw, "qualityGates") as Record<string, QualityGateRequirement | string>,
    git: parseGit(raw.git),
    conventionDocs: stringArray(raw, "conventionDocs"),
    detection: parseDetection(raw.detection),
  };
  for (const f of SCALAR_FIELDS) {
    const v = raw[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new ProfileFormatError(`${f} must be a string`);
    profile[f as ScalarField] = v;
  }
  return profile;
}

function parseGit(value: unknown): ProjectProfile["git"] {
  if (value === undefined || value === null) return { defaultBaseBranch: "main" };
  if (!isRecord(value)) throw new ProfileFormatError("git must be a mapping");
  // Older profiles may still carry git.executionMode (worktree/branch); it is ignored: agents work in the project folder.
  const branch = value.defaultBaseBranch ?? "main";
  if (typeof branch !== "string" || !branch) throw new ProfileFormatError("git.defaultBaseBranch must be a non-empty string");
  return { defaultBaseBranch: branch };
}

function parseDetection(value: unknown): Record<string, DetectedValue<unknown>> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ProfileFormatError("detection must be a mapping");
  const out: Record<string, DetectedValue<unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) throw new ProfileFormatError(`detection.${key} must be a mapping`);
    const confidence = entry.confidence;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      throw new ProfileFormatError(`detection.${key}.confidence must be a number between 0 and 1`);
    }
    const evidence = Array.isArray(entry.evidence) ? entry.evidence.filter((e): e is string => typeof e === "string") : [];
    const dv: DetectedValue<unknown> = { value: entry.value ?? null, confidence, evidence };
    if (entry.overridden === true) dv.overridden = true;
    out[key] = dv;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v === "") throw new ProfileFormatError(`${key} must be a non-empty string`);
  return v;
}

function stringArray(raw: Record<string, unknown>, key: string): string[] {
  const v = raw[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ProfileFormatError(`${key} must be a list of strings`);
  return v as string[];
}

function stringRecord(raw: Record<string, unknown>, key: string): Record<string, string> {
  const v = raw[key];
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) throw new ProfileFormatError(`${key} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue;
    if (typeof val !== "string") throw new ProfileFormatError(`${key}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
