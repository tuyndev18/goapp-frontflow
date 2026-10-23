import type { BusinessRequirement, DocumentIssue, SourceReference, SourceSnapshot } from "@frontflow/domain";
import { AUTO_ID_PREFIX, makeIssue, missingIdIssue } from "./issues.js";
import type { MdBlock, MdHeading, MdListItem, MdSection } from "./markdown.js";
import { flattenItem, sectionsOf, sourceRef, splitLines, tokenizeMarkdown } from "./markdown.js";
import {
  collapseWhitespace,
  escapeRegExp,
  extractErrorCodes,
  extractStateTokens,
  foldLabel,
  round2,
  splitValues,
  stripInline,
  uniq,
} from "./text.js";

/** A Given/When/Then statement found in the BA document. */
export interface AcceptanceCriterion {
  /** AC-001… in document order. */
  id: string;
  requirementId?: string;
  title?: string;
  given: string[];
  when: string[];
  then: string[];
  text: string;
  sourceRef: SourceReference;
}

export interface BaParseResult {
  requirements: BusinessRequirement[];
  acceptanceCriteria: AcceptanceCriterion[];
  actors: string[];
  issues: DocumentIssue[];
}

type Field = "actor" | "preconditions" | "actions" | "outcomes" | "errors" | "validations" | "states" | "permissions" | "notes";

const FIELD_LABELS: ReadonlyArray<readonly [Field, readonly string[]]> = [
  ["actor", ["actor", "actors", "role", "roles", "user role", "primary actor", "tac nhan", "vai tro", "nguoi dung", "doi tuong"]],
  [
    "preconditions",
    ["precondition", "preconditions", "pre condition", "pre conditions", "prerequisite", "prerequisites", "dieu kien", "dieu kien tien quyet", "tien dieu kien"],
  ],
  ["actions", ["action", "actions", "step", "steps", "flow", "main flow", "trigger", "hanh dong", "thao tac", "cac buoc", "luong", "luong chinh"]],
  [
    "outcomes",
    ["result", "results", "outcome", "outcomes", "expected result", "expected results", "postcondition", "postconditions", "post condition", "ket qua", "ket qua mong doi", "hau dieu kien"],
  ],
  ["errors", ["error", "errors", "error code", "error codes", "error cases", "failure", "failures", "exceptions", "loi", "ma loi", "cac loi", "truong hop loi"]],
  [
    "validations",
    ["validation", "validations", "validation rule", "validation rules", "rule", "rules", "business rule", "business rules", "constraint", "constraints", "rang buoc", "kiem tra", "quy tac", "kiem tra du lieu"],
  ],
  ["states", ["state", "states", "status", "statuses", "trang thai"]],
  ["permissions", ["permission", "permissions", "access", "authorization", "quyen", "phan quyen", "quyen han"]],
  ["notes", ["note", "notes", "description", "remark", "remarks", "api", "endpoint", "scope", "mo ta", "ghi chu", "pham vi"]],
];

const LABEL_INDEX = new Map<string, Field>(FIELD_LABELS.flatMap(([field, labels]) => labels.map((l) => [l, field] as const)));
const COMMA_SPLIT_FIELDS = new Set<Field>(["errors", "states", "permissions"]);

const ID_HEAD =
  /^(?:(?:[Rr]equirement|REQ|[Rr]eq|[Uu]ser [Ss]tory|[Ss]tory|[Yy]êu cầu)\s+)?\[?([A-Z][A-Z0-9]*(?:[-_.][A-Z0-9]+)*[-_.]\d+[A-Z]?)\]?(?:\s*[—–:|-]\s*|\s+|$)(.*)$/u;
const LABEL_LINE = /^([^:：]{1,40}?)\s*[:：]\s*(.*)$/;

const AC_SECTION = /^(?:acceptance\b|scenarios?\b|test scenarios?\b|tieu chi (?:chap nhan|nghiem thu)|kich ban)/;
const ACTOR_SECTION = /^(?:actors?|roles?|user roles|personas?|tac nhan|vai tro|nguoi dung)$/;
const SKIP_SECTION =
  /^(?:overview|introduction|background|context|glossary|terms|definitions|out of scope|non goals|references|changelog|change log|revision history|open questions|tong quan|gioi thieu|boi canh|thuat ngu|dinh nghia|ngoai pham vi|tai lieu tham khao|lich su)/;

const MODAL = /(?<![\p{L}])(?:must|shall|should|needs? to|is required to|are required to|phải|cần)(?![\p{L}])/iu;
const OUTCOME_HINT =
  /(?<![\p{L}])(?:becomes?|is (?:shown|displayed|updated|set|sent|created|saved|stored|notified)|are (?:shown|displayed|listed)|displays?|shows?|receives?|returns?|redirect\w*|so that|trở thành|hiển thị|nhận được|chuyển sang|được cập nhật|thông báo)(?![\p{L}])/iu;

const GWT_KEYWORD = /(?<![\p{L}])(Given|When|Then|And|But|Giả sử|Khi|Thì|Và|Nhưng)(?![\p{L}])/gu;
const GWT_START = /^(?:given|when|then|giả sử)(?![\p{L}])/iu;
const GWT_CONT = /^(?:and|but|when|then|và|nhưng|khi|thì)(?![\p{L}])/iu;
const SCENARIO_LINE = /^(?:scenario|kịch bản)\s*(?:\d+)?\s*[:：]\s*(.*)$/iu;

interface FieldBag {
  actor: string[];
  preconditions: string[];
  actions: string[];
  outcomes: string[];
  errors: string[];
  validations: string[];
  states: string[];
  permissions: string[];
  notes: string[];
  refs: SourceReference[];
}

function emptyBag(): FieldBag {
  return { actor: [], preconditions: [], actions: [], outcomes: [], errors: [], validations: [], states: [], permissions: [], notes: [], refs: [] };
}

export function matchLabel(text: string): { field: Field; value: string } | undefined {
  const m = LABEL_LINE.exec(text);
  if (!m) return undefined;
  const field = LABEL_INDEX.get(foldLabel(m[1]!));
  return field ? { field, value: (m[2] ?? "").trim() } : undefined;
}

export function matchRequirementId(text: string): { id: string; title: string } | undefined {
  const m = ID_HEAD.exec(stripInline(text));
  if (!m) return undefined;
  const id = m[1]!.toUpperCase();
  if (!/[A-Z]/.test(id.replace(/\d+[A-Z]?$/, ""))) return undefined;
  return { id, title: collapseWhitespace(m[2] ?? "") };
}

function headingField(heading: MdHeading): Field | "criteria" | undefined {
  const folded = foldLabel(heading.text);
  if (AC_SECTION.test(folded)) return "criteria";
  return LABEL_INDEX.get(folded);
}

// ---------------------------------------------------------------------------
// Given / When / Then
// ---------------------------------------------------------------------------

interface PendingCriterion {
  ownerId?: string;
  title?: string;
  section: string[];
  given: string[];
  when: string[];
  then: string[];
  lines: string[];
  lineStart: number;
  lineEnd: number;
}

class CriteriaCollector {
  readonly done: PendingCriterion[] = [];
  private current: PendingCriterion | undefined;
  private lastBucket: "given" | "when" | "then" = "given";

  /** Returns true when the line was consumed as part of a criterion. */
  feed(text: string, lineStart: number, lineEnd: number, section: string[], ownerId: string | undefined): boolean {
    const clean = stripInline(text);
    const scenario = SCENARIO_LINE.exec(clean);
    if (scenario) {
      this.close();
      this.current = this.start(ownerId, section, lineStart, lineEnd, clean);
      this.current.title = collapseWhitespace(scenario[1] ?? "") || undefined;
      return true;
    }
    const isStart = GWT_START.test(clean) && (/^(?:given|giả sử)/iu.test(clean) || /(?<![\p{L}])(?:Then|Thì)(?![\p{L}])/u.test(clean));
    const isCont = GWT_CONT.test(clean) && this.current !== undefined;
    if (!isStart && !isCont) return false;

    const segments = this.segments(clean);
    const first = segments[0];
    if (!first) return false;
    const opensNew = first.keyword === "given" && (this.current === undefined || this.hasBody(this.current));
    if (opensNew || this.current === undefined) {
      this.close();
      this.current = this.start(ownerId, section, lineStart, lineEnd, clean);
    } else {
      this.current.lines.push(clean);
      this.current.lineEnd = Math.max(this.current.lineEnd, lineEnd);
    }
    const target = this.current;
    for (const segment of segments) {
      const bucket = segment.keyword === "and" ? this.lastBucket : segment.keyword;
      if (segment.text) target[bucket].push(segment.text);
      this.lastBucket = bucket;
    }
    return true;
  }

  close(): void {
    if (this.current && this.hasBody(this.current)) this.done.push(this.current);
    this.current = undefined;
    this.lastBucket = "given";
  }

  private hasBody(c: PendingCriterion): boolean {
    return c.given.length + c.when.length + c.then.length > 0;
  }

  private start(ownerId: string | undefined, section: string[], lineStart: number, lineEnd: number, text: string): PendingCriterion {
    const c: PendingCriterion = { section, given: [], when: [], then: [], lines: [text], lineStart, lineEnd };
    if (ownerId) c.ownerId = ownerId;
    return c;
  }

  private segments(text: string): { keyword: "given" | "when" | "then" | "and"; text: string }[] {
    const marks: { keyword: "given" | "when" | "then" | "and"; index: number; length: number }[] = [];
    const leading = /^(\S+(?:\s+sử)?)/u.exec(text);
    for (const m of text.matchAll(GWT_KEYWORD)) {
      marks.push({ keyword: keywordOf(m[1]!), index: m.index, length: m[0].length });
    }
    if (marks.length === 0 || marks[0]!.index !== 0) {
      const word = leading?.[1] ?? "";
      marks.unshift({ keyword: keywordOf(word), index: 0, length: word.length });
    }
    return marks.map((mark, i) => {
      const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
      const body = text.slice(mark.index + mark.length, end).replace(/^[\s,:;]+|[\s,;.]+$/g, "");
      return { keyword: mark.keyword, text: collapseWhitespace(body) };
    });
  }
}

function keywordOf(word: string): "given" | "when" | "then" | "and" {
  const w = word.toLowerCase();
  if (w === "given" || w.startsWith("giả")) return "given";
  if (w === "when" || w === "khi") return "when";
  if (w === "then" || w === "thì") return "then";
  return "and";
}

// ---------------------------------------------------------------------------
// Field collection
// ---------------------------------------------------------------------------

function addValues(bag: FieldBag, field: Field, values: string[]): void {
  for (const value of values) {
    const clean = collapseWhitespace(value);
    if (clean) bag[field].push(clean);
  }
}

function valuesOfItem(item: MdListItem, inlineValue: string, field: Field): string[] {
  const values = inlineValue ? splitValues(inlineValue, COMMA_SPLIT_FIELDS.has(field)) : [];
  for (const child of item.children) {
    for (const text of flattenItem(child)) values.push(...splitValues(stripInline(text), false));
  }
  return values;
}

interface BodyContext {
  snapshotId: string;
  ownerId: string;
  criteria: CriteriaCollector;
}

function collectItems(items: MdListItem[], section: string[], defaultField: Field | undefined, bag: FieldBag, ctx: BodyContext): void {
  for (const item of items) {
    const clean = stripInline(item.text);
    const ownEnd = item.children.length > 0 ? item.lineStart : item.lineEnd;
    if (ctx.criteria.feed(item.text, item.lineStart, ownEnd, section, ctx.ownerId)) {
      for (const child of item.children) {
        for (const text of flattenItem(child)) ctx.criteria.feed(text, child.lineStart, child.lineEnd, section, ctx.ownerId);
      }
      continue;
    }
    ctx.criteria.close();
    const label = matchLabel(clean);
    const field = label?.field ?? defaultField ?? "notes";
    const values = label ? valuesOfItem(item, label.value, field) : [clean, ...valuesOfItem(item, "", field)];
    addValues(bag, field, values);
    bag.refs.push(sourceRef(ctx.snapshotId, item.lineStart, item.lineEnd, section, flattenItem(item).map(stripInline).join("; ")));
  }
}

function collectBody(blocks: MdBlock[], bag: FieldBag, ctx: BodyContext): void {
  let field: Field | undefined;
  let inCriteria = false;
  for (const block of blocks) {
    if (block.kind === "heading") {
      ctx.criteria.close();
      const hf = headingField(block);
      inCriteria = hf === "criteria";
      field = hf === "criteria" ? undefined : hf;
      continue;
    }
    if (block.kind === "list") {
      collectItems(block.items, block.section, field, bag, ctx);
      ctx.criteria.close();
      continue;
    }
    if (block.kind === "paragraph") {
      for (const line of block.lines) {
        if (ctx.criteria.feed(line.text, line.line, line.line, block.section, ctx.ownerId)) continue;
        ctx.criteria.close();
        const clean = stripInline(line.text);
        const label = matchLabel(clean);
        const target = label?.field ?? (inCriteria ? "notes" : field ?? "notes");
        addValues(bag, target, label ? splitValues(label.value, COMMA_SPLIT_FIELDS.has(target)) : [clean]);
        bag.refs.push(sourceRef(ctx.snapshotId, line.line, line.line, block.section, clean));
      }
      ctx.criteria.close();
    }
  }
  ctx.criteria.close();
}

function errorEntries(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const codes = extractErrorCodes(value, false).filter((c) => c.includes("_") || c.length >= 4);
    if (codes.length > 0) out.push(...codes);
    else out.push(value);
  }
  return uniq(out);
}

function buildRequirement(id: string, title: string, bag: FieldBag, headRef: SourceReference): BusinessRequirement {
  const actor = bag.actor.length > 0 ? uniq(bag.actor.flatMap((a) => splitValues(a, true))).join(", ") : undefined;
  const preconditions = uniq([...bag.preconditions, ...bag.permissions.map((p) => `Permission: ${p}`)]);
  const outcomes = uniq(bag.outcomes);
  const actions = uniq(bag.actions);
  const validations = uniq(bag.validations);
  const declaredStates = bag.states.flatMap((s) => {
    const tokens = extractStateTokens(s);
    return tokens.length > 0 ? tokens : [s];
  });
  const states = uniq([...declaredStates, ...extractStateTokens([...bag.preconditions, ...outcomes].join("\n"))]);
  const errors = uniq([
    ...errorEntries(bag.errors),
    ...extractErrorCodes([...outcomes, ...actions, ...bag.notes].join("\n"), true),
  ]);

  let confidence = 0.95;
  if (!actor) confidence -= 0.15;
  if (actions.length === 0) confidence -= 0.15;
  if (outcomes.length === 0) confidence -= 0.15;
  if (!title) confidence -= 0.05;

  const requirement: BusinessRequirement = {
    id,
    title: title || id,
    preconditions,
    actions,
    outcomes,
    validations,
    states,
    errors,
    sourceRefs: [headRef, ...bag.refs],
    confidence: round2(Math.max(0.3, confidence)),
  };
  if (actor) requirement.actor = actor;
  return requirement;
}

// ---------------------------------------------------------------------------
// Free-form fallback
// ---------------------------------------------------------------------------

function sentencesOf(text: string): string[] {
  return stripInline(text)
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function detectActor(sentences: string[], knownActors: string[]): string | undefined {
  for (const sentence of sentences) {
    for (const actor of knownActors) {
      if (new RegExp(`(?<![\\p{L}])${escapeRegExp(actor)}(?![\\p{L}])`, "iu").test(sentence)) return actor;
    }
  }
  for (const sentence of sentences) {
    const m = /^(?:the|a|an)?\s*([\p{L}][\p{L} ]{1,30}?)\s+(?:must|shall|should|needs? to|is required to|phải|cần)(?![\p{L}])/iu.exec(sentence);
    const subject = m?.[1]?.trim();
    if (subject && !/^(?:it|this|that|there|we|they)$/i.test(subject)) return subject.charAt(0).toUpperCase() + subject.slice(1);
  }
  return undefined;
}

interface FreeFormCandidate {
  title: string;
  heading: MdHeading;
  lineEnd: number;
  sentences: { text: string; lineStart: number; lineEnd: number; section: string[] }[];
}

function freeFormRequirement(id: string, candidate: FreeFormCandidate, snapshotId: string, knownActors: string[]): BusinessRequirement {
  const texts = candidate.sentences.map((s) => s.text);
  const modal = candidate.sentences.filter((s) => MODAL.test(s.text));
  const actions = uniq(modal.map((s) => s.text));
  const outcomes = uniq(texts.filter((t) => OUTCOME_HINT.test(t) || extractStateTokens(t).length > 0));
  const actor = detectActor(modal.map((s) => s.text), knownActors);
  const all = texts.join("\n");
  let confidence = 0.5;
  if (!actor) confidence -= 0.1;
  if (outcomes.length === 0) confidence -= 0.1;
  const requirement: BusinessRequirement = {
    id,
    title: candidate.title,
    preconditions: [],
    actions,
    outcomes,
    validations: [],
    states: extractStateTokens(all),
    errors: extractErrorCodes(all, true),
    sourceRefs: [
      sourceRef(snapshotId, candidate.heading.lineStart, candidate.lineEnd, candidate.heading.section, candidate.title),
      ...modal.map((s) => sourceRef(snapshotId, s.lineStart, s.lineEnd, s.section, s.text)),
    ],
    confidence: round2(confidence),
  };
  if (actor) requirement.actor = actor;
  return requirement;
}

function ownSentences(section: MdSection): FreeFormCandidate["sentences"] {
  const out: FreeFormCandidate["sentences"] = [];
  for (const block of section.own) {
    if (block.kind === "paragraph") {
      for (const s of sentencesOf(block.text)) out.push({ text: s, lineStart: block.lineStart, lineEnd: block.lineEnd, section: block.section });
    } else if (block.kind === "list") {
      const walk = (items: MdListItem[]) => {
        for (const item of items) {
          for (const s of sentencesOf(item.text)) out.push({ text: s, lineStart: item.lineStart, lineEnd: item.lineEnd, section: block.section });
          walk(item.children);
        }
      };
      walk(block.items);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isWithin(line: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

/** Spec §12.1 A2 — extract business requirements from BA Markdown (template first, free-form fallback). */
export function parseBaMarkdown(snapshot: SourceSnapshot, text: string): BaParseResult {
  const snapshotId = snapshot.id;
  const blocks = tokenizeMarkdown(text);
  const sections = sectionsOf(blocks);
  const issues: DocumentIssue[] = [];

  const actors: string[] = [];
  for (const section of sections) {
    if (!ACTOR_SECTION.test(foldLabel(section.heading.text))) continue;
    for (const block of section.own) {
      if (block.kind !== "list") continue;
      for (const item of block.items) {
        const name = stripInline(item.text).split(/\s*(?:[:：]|\s[—–-]\s|\()/u)[0]?.trim();
        if (name) actors.push(name);
      }
    }
  }

  const found: { requirement: BusinessRequirement; line: number }[] = [];
  const criteria = new CriteriaCollector();
  const claimed: { start: number; end: number }[] = [];

  for (const section of sections) {
    const match = matchRequirementId(section.heading.text);
    if (!match || isWithin(section.heading.lineStart, claimed)) continue;
    claimed.push({ start: section.heading.lineStart, end: section.lineEnd });
    const bag = emptyBag();
    collectBody(section.body, bag, { snapshotId, ownerId: match.id, criteria });
    const headRef = sourceRef(snapshotId, section.heading.lineStart, section.lineEnd, section.heading.section, section.heading.text);
    found.push({ requirement: buildRequirement(match.id, match.title, bag, headRef), line: section.heading.lineStart });
  }

  // Requirements written as ID-prefixed list items: "- BA-ORDER-009: Customer …".
  for (const block of blocks) {
    if (block.kind !== "list" || isWithin(block.lineStart, claimed)) continue;
    if (block.section.some((s) => AC_SECTION.test(foldLabel(s)) || ACTOR_SECTION.test(foldLabel(s)))) continue;
    for (const item of block.items) {
      const match = matchRequirementId(item.text);
      if (!match) continue;
      const bag = emptyBag();
      const ctx = { snapshotId, ownerId: match.id, criteria };
      collectItems(item.children, block.section, undefined, bag, ctx);
      criteria.close();
      const headRef = sourceRef(snapshotId, item.lineStart, item.lineEnd, block.section, stripInline(item.text));
      found.push({ requirement: buildRequirement(match.id, match.title, bag, headRef), line: item.lineStart });
      claimed.push({ start: item.lineStart, end: item.lineEnd });
    }
  }

  // Global acceptance-criteria sections.
  for (const section of sections) {
    if (!AC_SECTION.test(foldLabel(section.heading.text)) || isWithin(section.heading.lineStart, claimed)) continue;
    claimed.push({ start: section.heading.lineStart, end: section.lineEnd });
    for (const block of section.body) {
      if (block.kind === "list") {
        const walk = (items: MdListItem[]) => {
          for (const item of items) {
            if (!criteria.feed(item.text, item.lineStart, item.lineStart, block.section, undefined)) criteria.close();
            walk(item.children);
          }
        };
        walk(block.items);
      } else if (block.kind === "paragraph") {
        for (const line of block.lines) {
          if (!criteria.feed(line.text, line.line, line.line, block.section, undefined)) criteria.close();
        }
      }
      criteria.close();
    }
  }

  // Free-form fallback: sections without IDs whose sentences state obligations.
  const requirementLines = found.map((f) => f.line);
  const freeForm: FreeFormCandidate[] = [];
  for (const section of sections) {
    const heading = section.heading;
    if (heading.level < 2 || isWithin(heading.lineStart, claimed)) continue;
    if (section.heading.section.some((s) => SKIP_SECTION.test(foldLabel(s)) || ACTOR_SECTION.test(foldLabel(s)) || AC_SECTION.test(foldLabel(s)))) continue;
    if (requirementLines.some((l) => l > heading.lineStart && l <= section.lineEnd)) continue;
    const sentences = ownSentences(section);
    if (!sentences.some((s) => MODAL.test(s.text))) continue;
    freeForm.push({ title: heading.text, heading, lineEnd: section.lineEnd, sentences });
  }
  freeForm.forEach((candidate, i) => {
    const id = `${AUTO_ID_PREFIX}${String(i + 1).padStart(3, "0")}`;
    const requirement = freeFormRequirement(id, candidate, snapshotId, actors);
    found.push({ requirement, line: candidate.heading.lineStart });
    issues.push(missingIdIssue(requirement));
  });

  found.sort((a, b) => a.line - b.line);
  const requirements = found.map((f) => f.requirement);

  const ids = uniq(requirements.map((r) => r.id));
  const acceptanceCriteria = criteria.done
    .slice()
    .sort((a, b) => a.lineStart - b.lineStart)
    .map((c, i): AcceptanceCriterion => {
      const ac: AcceptanceCriterion = {
        id: `AC-${String(i + 1).padStart(3, "0")}`,
        given: c.given,
        when: c.when,
        then: c.then,
        text: c.lines.join("\n"),
        sourceRef: sourceRef(snapshotId, c.lineStart, c.lineEnd, c.section, c.lines.join(" ")),
      };
      const owner = c.ownerId ?? attachCriterion(c, ids);
      if (owner) ac.requirementId = owner;
      if (c.title) ac.title = c.title;
      return ac;
    });

  for (const requirement of requirements) {
    if (requirement.actor && !actors.some((a) => a.toLowerCase() === requirement.actor!.toLowerCase())) actors.push(requirement.actor);
  }

  if (requirements.length === 0) {
    const lineCount = splitLines(text).length;
    issues.push(
      makeIssue(
        "empty_document",
        "error",
        "No business requirements could be extracted from the BA document.",
        { detail: snapshotId },
        [sourceRef(snapshotId, 1, lineCount, undefined, splitLines(text)[0] ?? "")],
      ),
    );
  }

  return { requirements, acceptanceCriteria, actors: uniq(actors), issues };
}

function attachCriterion(c: PendingCriterion, ids: string[]): string | undefined {
  const haystack = [...c.section, c.title ?? "", ...c.lines].join("\n").toUpperCase();
  let best: { id: string; index: number } | undefined;
  for (const id of ids) {
    const m = new RegExp(`(?<![A-Z0-9-])${escapeRegExp(id)}(?![A-Z0-9-])`).exec(haystack);
    if (m && (!best || m.index < best.index || (m.index === best.index && id.length > best.id.length))) best = { id, index: m.index };
  }
  return best?.id;
}
