import type { DetectedValue, ProjectProfile, QualityGateRequirement } from "@frontflow/domain";

/** User corrections to a detected profile. `null` clears a value. */
export interface ProfileOverrides {
  projectId?: string;
  framework?: string | null;
  language?: string | null;
  packageManager?: string | null;
  uiLibrary?: string | null;
  apiClient?: string | null;
  stateManagement?: string | null;
  testFrameworks?: string[];
  conventionDocs?: string[];
  commands?: Record<string, string | null | undefined>;
  qualityGates?: Record<string, QualityGateRequirement | string | null | undefined>;
  git?: Partial<ProjectProfile["git"]>;
}

const SCALARS = ["framework", "language", "packageManager", "uiLibrary", "apiClient", "stateManagement"] as const;

function overridden<T>(value: T): DetectedValue<T> {
  return { value, confidence: 1, evidence: ["user override"], overridden: true };
}

/** Returns a new profile with overrides applied; overridden detection entries get confidence 1. */
export function applyOverrides(profile: ProjectProfile, overrides: ProfileOverrides): ProjectProfile {
  const next: ProjectProfile = {
    ...profile,
    testFrameworks: [...profile.testFrameworks],
    commands: { ...profile.commands },
    qualityGates: { ...profile.qualityGates },
    git: { ...profile.git },
    conventionDocs: [...profile.conventionDocs],
    detection: { ...profile.detection },
  };
  const mark = (key: string, value: unknown) => {
    next.detection[key] = overridden(value);
  };

  if (overrides.projectId !== undefined) {
    if (!overrides.projectId) throw new Error("projectId cannot be empty");
    next.projectId = overrides.projectId;
  }
  for (const field of SCALARS) {
    if (!(field in overrides)) continue;
    const value = overrides[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
    mark(field, value);
  }
  if (overrides.testFrameworks) {
    next.testFrameworks = [...overrides.testFrameworks];
    mark("testFrameworks", next.testFrameworks);
  }
  if (overrides.conventionDocs) {
    next.conventionDocs = [...overrides.conventionDocs];
    mark("conventionDocs", next.conventionDocs);
  }
  for (const [name, value] of Object.entries(overrides.commands ?? {})) {
    if (value === undefined) continue;
    if (value === null) delete next.commands[name];
    else next.commands[name] = value;
    mark(`commands.${name}`, value);
  }
  for (const [name, value] of Object.entries(overrides.qualityGates ?? {})) {
    if (value === undefined) continue;
    if (value === null) delete next.qualityGates[name];
    else next.qualityGates[name] = value;
    mark(`qualityGates.${name}`, value);
  }
  if (overrides.git?.defaultBaseBranch !== undefined) {
    if (!overrides.git.defaultBaseBranch) throw new Error("git.defaultBaseBranch cannot be empty");
    next.git.defaultBaseBranch = overrides.git.defaultBaseBranch;
    mark("git.defaultBaseBranch", next.git.defaultBaseBranch);
  }
  return next;
}
