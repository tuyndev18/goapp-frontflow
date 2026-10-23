import type { ApiOperation, BusinessRequirement } from "@frontflow/domain";
import { operationStates } from "./schema.js";
import { escapeRegExp, isVariantOf, rolesMatch, round2, stem, wordSet, wordTokens } from "./text.js";

export type LinkSignalKind = "explicit_reference" | "error_code" | "state" | "state_variant" | "verb_method" | "action_segment" | "token_overlap" | "actor_role";

export interface LinkSignal {
  kind: LinkSignalKind;
  weight: number;
  detail: string;
}

/** Candidate requirement ↔ operation link (spec §12.1 A5). */
export interface RequirementApiLink {
  requirementId: string;
  operationId: string;
  /** 0..1; 1 for explicit references. */
  score: number;
  explicit: boolean;
  signals: LinkSignal[];
}

export interface MapOptions {
  /** Minimum score for a candidate link. Default 0.25. */
  minScore?: number;
  /** Links scoring below best × ratio are dropped. Default 0.6. */
  relativeCutoff?: number;
  /** Maximum inferred links per requirement. Default 3. */
  maxLinks?: number;
}

type VerbClass = "create" | "read" | "update" | "delete" | "action";

const VERB_CLASSES: Record<Exclude<VerbClass, "action">, string[]> = {
  create: ["create", "add", "new", "register", "tạo", "thêm", "đăng ký"],
  read: ["view", "list", "get", "see", "show", "search", "display", "fetch", "browse", "find", "read", "xem", "tìm", "tra cứu", "danh sách"],
  update: ["update", "edit", "modify", "change", "rename", "sửa", "cập nhật", "thay đổi", "chỉnh sửa"],
  delete: ["delete", "remove", "xóa", "xoá"],
};

const ACTION_VERBS = [
  "cancel", "approve", "reject", "submit", "confirm", "complete", "archive", "publish", "ship", "refund", "pay",
  "assign", "close", "reopen", "activate", "deactivate", "lock", "unlock", "verify", "send", "resend", "restore",
  "checkout", "login", "logout", "export", "import", "upload", "download", "retry", "return", "accept", "decline",
];

const VI_ACTIONS: Record<string, string> = {
  hủy: "cancel",
  huỷ: "cancel",
  duyệt: "approve",
  "phê duyệt": "approve",
  "xác nhận": "confirm",
  "từ chối": "reject",
  gửi: "submit",
  "hoàn tiền": "refund",
  "thanh toán": "pay",
  "giao hàng": "ship",
};

function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?<![\\p{L}])${escapeRegExp(phrase)}(?![\\p{L}])`, "iu").test(text);
}

interface RequirementProfile {
  requirement: BusinessRequirement;
  fullText: string;
  verbText: string;
  verbClasses: Set<VerbClass>;
  actionStems: Set<string>;
  tokens: Set<string>;
  errorCodes: string[];
  states: string[];
}

function requirementText(r: BusinessRequirement): string {
  return [
    r.id,
    r.title,
    r.actor ?? "",
    ...r.preconditions,
    ...r.actions,
    ...r.outcomes,
    ...r.validations,
    ...r.errors,
    ...r.sourceRefs.map((s) => s.excerpt ?? ""),
  ].join("\n");
}

export function profileRequirement(r: BusinessRequirement): RequirementProfile {
  const verbText = [r.title, ...r.actions].join("\n");
  const verbTokens = wordSet(verbText);
  const verbClasses = new Set<VerbClass>();
  for (const [cls, words] of Object.entries(VERB_CLASSES) as [VerbClass, string[]][]) {
    if (words.some((w) => (w.includes(" ") || /[^\x00-\x7f]/.test(w) ? containsPhrase(verbText, w) : verbTokens.has(stem(w))))) verbClasses.add(cls);
  }
  const actionStems = new Set<string>();
  for (const verb of ACTION_VERBS) if (verbTokens.has(stem(verb))) actionStems.add(stem(verb));
  for (const [phrase, verb] of Object.entries(VI_ACTIONS)) if (containsPhrase(verbText, phrase)) actionStems.add(stem(verb));
  if (actionStems.size > 0) verbClasses.add("action");

  return {
    requirement: r,
    fullText: requirementText(r),
    verbText,
    verbClasses,
    actionStems,
    tokens: wordSet([r.title, ...r.actions, ...r.outcomes].join("\n")),
    errorCodes: r.errors.filter((e) => /^[A-Z][A-Z0-9_]+$/.test(e)),
    states: r.states,
  };
}

interface OperationProfile {
  operation: ApiOperation;
  verbClass: VerbClass;
  actionSegment?: string;
  tokens: Set<string>;
  errorCodes: Set<string>;
  states: string[];
}

function staticSegments(path: string): string[] {
  return path.split("/").filter((s) => s && !s.startsWith("{") && !s.startsWith(":"));
}

const ACTION_STEMS = new Set(ACTION_VERBS.map(stem));

export function profileOperation(op: ApiOperation): OperationProfile {
  const method = op.method.toUpperCase();
  const segments = op.path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  const lastStatic = last && !last.startsWith("{") && !last.startsWith(":") ? stem(wordTokens(last)[0] ?? last) : undefined;
  // Unknown trailing singular segments under a resource (POST /orders/{id}/escalate) are treated as actions.
  const knownVerb =
    lastStatic !== undefined && (ACTION_STEMS.has(lastStatic) || (segments.length > 1 && /^[a-z]+$/.test(last!) && !last!.endsWith("s")));
  let verbClass: VerbClass;
  let actionSegment: string | undefined;
  if (method === "GET" || method === "HEAD") verbClass = "read";
  else if (method === "PUT" || method === "PATCH") verbClass = "update";
  else if (method === "DELETE") verbClass = "delete";
  else if (knownVerb && lastStatic) {
    verbClass = "action";
    actionSegment = lastStatic;
  } else verbClass = "create";

  const profile: OperationProfile = {
    operation: op,
    verbClass,
    tokens: wordSet([op.id, ...staticSegments(op.path), op.summary ?? ""].join(" ")),
    errorCodes: new Set(op.responses.map((r) => r.errorCode).filter((c): c is string => !!c)),
    states: operationStates(op),
  };
  if (actionSegment) profile.actionSegment = actionSegment;
  return profile;
}

function pathPattern(op: ApiOperation): RegExp {
  const body = op.path
    .split("/")
    .map((segment) => (segment.startsWith("{") ? "(?:\\{[^}\\s]+\\}|:[\\w-]+|<[^>\\s]+>)" : escapeRegExp(segment)))
    .join("/");
  return new RegExp(`(?<![A-Za-z])${op.method}\\s+\`?${body}(?![\\w/{])`, "i");
}

export function explicitlyReferences(text: string, op: ApiOperation): string | undefined {
  if (op.id.length >= 4 && new RegExp(`(?<![\\w-])${escapeRegExp(op.id)}(?![\\w-])`).test(text)) return `mentions operation ${op.id}`;
  if (pathPattern(op).test(text)) return `mentions ${op.method} ${op.path}`;
  return undefined;
}

function actorRoles(actor: string | undefined): string[] {
  if (!actor) return [];
  return actor.split(/[,;/]|\s+or\s+|\s+hoặc\s+/iu).map((a) => a.trim()).filter(Boolean);
}

function scorePair(rp: RequirementProfile, op: OperationProfile, errorFrequency: Map<string, number>): RequirementApiLink {
  const signals: LinkSignal[] = [];
  const base = { requirementId: rp.requirement.id, operationId: op.operation.id };

  const explicit = explicitlyReferences(rp.fullText, op.operation);
  if (explicit) return { ...base, score: 1, explicit: true, signals: [{ kind: "explicit_reference", weight: 1, detail: explicit }] };

  const sharedErrors = rp.errorCodes.filter((c) => op.errorCodes.has(c));
  if (sharedErrors.length > 0) {
    const weight = round2(Math.min(0.5, sharedErrors.reduce((sum, c) => sum + 0.35 / (errorFrequency.get(c) ?? 1), 0)));
    signals.push({ kind: "error_code", weight, detail: `shared error codes ${sharedErrors.join(", ")}` });
  }

  const sharedStates = rp.states.filter((s) => op.states.includes(s));
  if (sharedStates.length > 0) {
    signals.push({ kind: "state", weight: Math.min(0.25, 0.15 * sharedStates.length), detail: `response exposes ${sharedStates.join(", ")}` });
  } else {
    const variants = rp.states.filter((s) => op.states.some((o) => isVariantOf(s, o)));
    if (variants.length > 0) signals.push({ kind: "state_variant", weight: 0.1, detail: `response exposes a variant of ${variants.join(", ")}` });
  }

  if (op.actionSegment && rp.actionStems.has(op.actionSegment)) {
    signals.push({ kind: "action_segment", weight: 0.3, detail: `action "${op.actionSegment}" matches ${op.operation.method} …/${op.actionSegment}` });
  } else if (rp.verbClasses.has(op.verbClass) && op.verbClass !== "action") {
    signals.push({ kind: "verb_method", weight: 0.2, detail: `${op.verbClass} verb matches ${op.operation.method}` });
  } else if (rp.verbClasses.size > 0) {
    const expected = [...rp.verbClasses].join("/");
    signals.push({ kind: "verb_method", weight: -0.15, detail: `${expected} verb does not match ${op.operation.method} ${op.operation.path}` });
  }

  const overlap = [...op.tokens].filter((t) => rp.tokens.has(t));
  if (overlap.length > 0 && op.tokens.size > 0) {
    signals.push({ kind: "token_overlap", weight: round2((0.3 * overlap.length) / op.tokens.size), detail: `shared terms ${overlap.join(", ")}` });
  }

  const roles = actorRoles(rp.requirement.actor);
  const roleHit = roles.find((a) => op.operation.roles.some((r) => rolesMatch(a, r)));
  if (roleHit) signals.push({ kind: "actor_role", weight: 0.05, detail: `actor ${roleHit} is an allowed role` });

  const score = round2(Math.max(0, Math.min(0.95, signals.reduce((sum, s) => sum + s.weight, 0))));
  return { ...base, score, explicit: false, signals };
}

/** Spec §12.1 A5 — deterministic many-to-many candidate links between requirements and operations. */
export function mapRequirementsToApi(
  requirements: BusinessRequirement[],
  operations: ApiOperation[],
  options: MapOptions = {},
): RequirementApiLink[] {
  const minScore = options.minScore ?? 0.25;
  const cutoff = options.relativeCutoff ?? 0.6;
  const maxLinks = options.maxLinks ?? 3;
  const ops = operations.map(profileOperation);
  const errorFrequency = new Map<string, number>();
  for (const op of ops) for (const code of op.errorCodes) errorFrequency.set(code, (errorFrequency.get(code) ?? 0) + 1);

  const links: RequirementApiLink[] = [];
  const seen = new Set<string>();
  for (const requirement of requirements) {
    const key = `${requirement.id}\u0000${requirement.sourceRefs[0]?.lineStart ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rp = profileRequirement(requirement);
    const scored = ops.map((op) => scorePair(rp, op, errorFrequency));
    const explicit = scored.filter((l) => l.explicit);
    if (explicit.length > 0) {
      links.push(...explicit);
      continue;
    }
    const candidates = scored
      .filter((l) => l.score >= minScore)
      .sort((a, b) => b.score - a.score || (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
    const best = candidates[0]?.score ?? 0;
    links.push(...candidates.filter((l) => l.score >= best * cutoff).slice(0, maxLinks));
  }
  return links;
}
