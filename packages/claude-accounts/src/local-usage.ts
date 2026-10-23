import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { estimateCost } from "@frontflow/domain";
import type { TimelineEntry } from "./types.js";

/** One API message found in a Claude transcript. Counts only. */
export interface TranscriptMessage {
  id: string;
  at: number;
  model?: string;
  /** Working folder of the session (its `cwd`), else the transcript's project folder name. */
  project?: string;
  /** Transcript file name (Claude's session id); subagent transcripts count for their parent. */
  session?: string;
  /** All input tokens, cached included. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Part of cacheWrite cached for 1 hour (priced higher than the 5-minute cache). */
  cacheWrite1h?: number;
}

export interface LocalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messages: number;
  estimatedCostUsd: number;
  unpricedModels: string[];
  last24h: { tokens: number; estimatedCostUsd: number };
  last7d: { tokens: number; estimatedCostUsd: number };
  lastMessageAt?: string;
}

/**
 * Reads usage from `<config>/projects/**\/*.jsonl` incrementally: a file is parsed again only
 * when its size or mtime changed; files untouched since `sinceMs` are skipped. Messages are
 * deduplicated by API message id (resumed and forked sessions copy them), last report wins.
 */
export class TranscriptScanner {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; messages: TranscriptMessage[] }>();

  /**
   * Async and yielding between files: a first scan of a large history takes seconds and must
   * not freeze the app's main process. Later scans only stat files that did not change.
   */
  async scan(projectsDir: string, sinceMs: number): Promise<TranscriptMessage[]> {
    // Long sessions reach tens of MB: files are read line by line, never skipped or loaded whole.
    let files: string[];
    try {
      files = ((await readdir(projectsDir, { recursive: true })) as string[]).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const byId = new Map<string, TranscriptMessage>();
    for (const rel of files) {
      const file = join(projectsDir, rel);
      // <project>/<session>.jsonl, or <project>/<session>/subagents/<agent>.jsonl
      const [folder, second] = rel.split(/[\\/]/);
      const origin = { project: folder ?? rel, session: (second ?? rel).replace(/\.jsonl$/, "") };
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs < sinceMs) continue;
      seen.add(file);
      let entry = this.cache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        const messages = (await parseTranscriptFile(file).catch(() => [])).map((m) => ({ ...m, project: m.project ?? origin.project, session: origin.session }));
        entry = { mtimeMs: st.mtimeMs, size: st.size, messages };
        this.cache.set(file, entry);
        await new Promise((r) => setImmediate(r));
      }
      for (const m of entry.messages) if (m.at >= sinceMs) byId.set(m.id, m);
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return [...byId.values()];
  }
}

/** Assistant entries with usage; a half-written last line is skipped. */
export function parseTranscript(text: string): TranscriptMessage[] {
  const out = new Map<string, TranscriptMessage>();
  for (const line of text.split("\n")) parseLine(line, out);
  return [...out.values()];
}

/** parseTranscript, streaming the file. */
export async function parseTranscriptFile(file: string): Promise<TranscriptMessage[]> {
  const out = new Map<string, TranscriptMessage>();
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) parseLine(line, out);
  return [...out.values()];
}

/** A message is written once per content block; the last line carries its final usage. */
function parseLine(line: string, out: Map<string, TranscriptMessage>): void {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (entry["type"] !== "assistant") return;
  const message = entry["message"] as Record<string, unknown> | undefined;
  const usage = message?.["usage"] as Record<string, unknown> | undefined;
  const id = typeof message?.["id"] === "string" ? (message["id"] as string) : undefined;
  const at = typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) : NaN;
  if (!id || !usage || !Number.isFinite(at)) return;
  const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const cacheRead = n("cache_read_input_tokens");
  const cacheWrite = n("cache_creation_input_tokens");
  const split = usage["cache_creation"] as Record<string, unknown> | undefined;
  const cacheWrite1h = typeof split?.["ephemeral_1h_input_tokens"] === "number" ? Math.min(cacheWrite, split["ephemeral_1h_input_tokens"] as number) : 0;
  const model = typeof message?.["model"] === "string" ? (message["model"] as string) : undefined;
  const cwd = typeof entry["cwd"] === "string" && entry["cwd"] ? (entry["cwd"] as string) : undefined;
  out.set(id, {
    id,
    at,
    ...(model && model !== "<synthetic>" ? { model } : {}),
    ...(cwd ? { project: cwd } : {}),
    input: n("input_tokens") + cacheRead + cacheWrite,
    output: n("output_tokens"),
    cacheRead,
    cacheWrite,
    ...(cacheWrite1h ? { cacheWrite1h } : {}),
  });
}

/** What a message costs at API prices; 1-hour cache writes are priced apart from 5-minute ones. */
export function messageCost(m: TranscriptMessage): ReturnType<typeof estimateCost> {
  return estimateCost(m.model, { inputTokens: m.input, outputTokens: m.output, cacheReadTokens: m.cacheRead, cacheWriteTokens: m.cacheWrite, cacheWrite1hTokens: m.cacheWrite1h ?? 0 });
}

/**
 * Attributes each message to the account that held the machine-wide login at that time
 * (from FrontFlow's timeline). Messages before tracking began, or under an unknown login,
 * stay unattributed rather than being guessed.
 */
export function usageByAccount(messages: TranscriptMessage[], timeline: TimelineEntry[], now: number): { byAccount: Map<string, LocalUsage>; unattributed: LocalUsage } {
  const ownerAt = accountOwner(timeline);
  const byAccount = new Map<string, LocalUsage>();
  const unattributed = emptyLocalUsage();
  for (const m of messages) {
    const owner = ownerAt(m.at);
    const target = owner ? (byAccount.get(owner) ?? byAccount.set(owner, emptyLocalUsage()).get(owner)!) : unattributed;
    add(target, m, now);
  }
  return { byAccount, unattributed };
}

/** The account that held the machine-wide login at a time; null before tracking or under an unknown login. */
export function accountOwner(timeline: TimelineEntry[]): (at: number) => string | null {
  const spans = timeline.map((t) => ({ accountId: t.accountId, at: Date.parse(t.at) })).filter((t) => Number.isFinite(t.at)).sort((a, b) => a.at - b.at);
  return (at) => {
    let owner: string | null = null;
    for (const s of spans) {
      if (s.at > at) break;
      owner = s.accountId;
    }
    return owner;
  };
}

export function emptyLocalUsage(): LocalUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messages: 0,
    estimatedCostUsd: 0,
    unpricedModels: [],
    last24h: { tokens: 0, estimatedCostUsd: 0 },
    last7d: { tokens: 0, estimatedCostUsd: 0 },
  };
}

function add(u: LocalUsage, m: TranscriptMessage, now: number): void {
  const est = messageCost(m);
  const usd = est.ok ? est.usd : 0;
  if (!est.ok && !u.unpricedModels.includes(m.model ?? "unknown")) u.unpricedModels.push(m.model ?? "unknown");
  const tokens = m.input + m.output;
  u.inputTokens += m.input;
  u.outputTokens += m.output;
  u.cacheReadTokens += m.cacheRead;
  u.cacheWriteTokens += m.cacheWrite;
  u.messages += 1;
  u.estimatedCostUsd += usd;
  if (now - m.at <= 86_400_000) {
    u.last24h.tokens += tokens;
    u.last24h.estimatedCostUsd += usd;
  }
  if (now - m.at <= 7 * 86_400_000) {
    u.last7d.tokens += tokens;
    u.last7d.estimatedCostUsd += usd;
  }
  const iso = new Date(m.at).toISOString();
  if (!u.lastMessageAt || iso > u.lastMessageAt) u.lastMessageAt = iso;
}
