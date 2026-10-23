import { redactString } from "@frontflow/event-schema";

export interface ClaudeProcess {
  pid: number;
  name: string;
  startedAt?: string;
  /** Shortened and redacted. */
  command: string;
}

/** `env` is passed for `ps`: `LC_ALL=C TZ=UTC` makes its start times parseable and unambiguous. */
export type ExecFn = (file: string, args: string[], env?: Record<string, string>) => Promise<string>;

const WINDOWS_QUERY = [
  "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='node.exe'\"",
  "| Where-Object { $_.Name -eq 'claude.exe' -or $_.CommandLine -match '@anthropic-ai[\\\\/]claude-code' }",
  "| ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; start = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); cmd = $_.CommandLine } }",
  "| ConvertTo-Json -Compress",
].join(" ");

/**
 * Running Claude Code processes. Each keeps the login it read at start in memory, so after a
 * switch it still uses — and may write back — the previous account until it is restarted.
 */
export async function listClaudeProcesses(exec: ExecFn, platform: NodeJS.Platform = process.platform): Promise<ClaudeProcess[]> {
  try {
    if (platform === "win32") {
      const out = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY])).trim();
      if (!out) return [];
      const parsed = JSON.parse(out) as unknown;
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ pid?: number; name?: string; start?: string | null; cmd?: string | null }>;
      return rows
        .filter((r) => typeof r.pid === "number")
        .map((r) => ({ pid: r.pid!, name: r.name ?? "claude", ...(r.start ? { startedAt: r.start } : {}), command: shorten(r.cmd ?? r.name ?? "") }));
    }
    const out = await exec("ps", ["-eo", "pid=,lstart=,args="], { LC_ALL: "C", TZ: "UTC" });
    const list: ClaudeProcess[] = [];
    for (const line of out.split("\n")) {
      // pid, then lstart "Thu Oct 23 10:00:00 2026" (5 words), then the command.
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (!m) continue;
      const args = m[3]!;
      if (!/(^|[\s/])claude(\s|$)|@anthropic-ai\/claude-code/.test(args)) continue;
      const start = Date.parse(`${m[2]!} UTC`);
      list.push({ pid: Number(m[1]), name: "claude", ...(Number.isFinite(start) ? { startedAt: new Date(start).toISOString() } : {}), command: shorten(args) });
    }
    return list;
  } catch {
    return [];
  }
}

function shorten(command: string): string {
  const safe = redactString(command.replace(/\s+/g, " ").trim());
  return safe.length > 160 ? `${safe.slice(0, 157)}…` : safe;
}
