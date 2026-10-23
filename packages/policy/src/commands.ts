export interface CommandClassification {
  destructive: boolean;
  network: boolean;
  reasons: string[];
}

interface Rule {
  test: (segment: string) => boolean;
  reason: string | ((segment: string) => string);
  destructive?: boolean;
  network?: boolean;
}

/** Matches `word` (a regex fragment) in command position, optionally behind sudo/xargs/env. */
function at(word: string, flags = "i"): RegExp {
  return new RegExp(String.raw`(?:^|[\s"'(\x60{])(?:(?:sudo|doas|xargs|env|command|exec|time|nohup)\s+(?:-\S+\s+)*)?(?:${word})(?=$|[\s"')}])`, flags);
}

const re = (r: RegExp) => (s: string) => r.test(s);
const all = (...rs: RegExp[]) => (s: string) => rs.every((r) => r.test(s));

const GIT = String.raw`\bgit(?:\.exe)?\b`;

const SEGMENT_RULES: Rule[] = [
  // File deletion
  {
    test: re(at("rm")),
    destructive: true,
    reason: (s) => (/\s-(?:[a-z]*r[a-z]*\b|-recursive\b|recurse\b)/i.test(s) ? "recursive delete (rm -r)" : "file deletion (rm)"),
  },
  {
    test: re(at("rmdir|rd")),
    destructive: true,
    reason: (s) => (/\s\/s\b/i.test(s) || /\s-(?:[a-z]*p|-parents)/i.test(s) ? "recursive directory delete (rmdir /s)" : "directory removal (rmdir)"),
  },
  {
    test: re(at("del|erase")),
    destructive: true,
    reason: (s) => (/\s\/s\b/i.test(s) ? "recursive delete (del /s)" : "file deletion (del)"),
  },
  {
    test: re(at("Remove-Item|ri")),
    destructive: true,
    reason: (s) => (/\s-r(?:ecurse)?\b/i.test(s) ? "recursive delete (Remove-Item -Recurse)" : "file deletion (Remove-Item)"),
  },
  { test: re(at("rimraf|del-cli|trash")), destructive: true, reason: "recursive delete (rimraf)" },
  { test: all(at("find"), /\s-(?:delete\b|exec(?:dir)?\s+rm\b)/i), destructive: true, reason: "find with delete" },
  { test: re(at("shred|wipefs")), destructive: true, reason: "secure erase" },

  // Git history / working-tree destroyers
  { test: re(new RegExp(String.raw`${GIT}.*\sreset\b.*\s--hard\b`, "i")), destructive: true, reason: "git reset --hard" },
  { test: re(new RegExp(String.raw`${GIT}.*\sclean\b.*\s-(?:[a-z]*f|-force\b)`, "i")), destructive: true, reason: "git clean -f" },
  {
    test: re(new RegExp(String.raw`${GIT}.*\spush\b.*(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-zA-Z]*f\b|\s\+\S)`)),
    destructive: true,
    reason: "git push --force",
  },
  {
    test: re(new RegExp(String.raw`${GIT}.*\spush\b.*(?:\s--delete\b|\s-d\b|\s:\S)`)),
    destructive: true,
    reason: "git push deleting a remote ref",
  },
  {
    test: re(new RegExp(String.raw`${GIT}.*\scheckout\b.*(?:\s--\s+\S|\s-f\b|\s--force\b|\s\.(?:\s|$))`, "i")),
    destructive: true,
    reason: "git checkout discarding working tree changes",
  },
  { test: re(new RegExp(String.raw`${GIT}.*\srestore\b`, "i")), destructive: true, reason: "git restore discarding changes" },
  {
    test: re(new RegExp(String.raw`${GIT}.*\sbranch\b.*(?:\s-D\b|\s--delete\b.*\s(?:-f|--force)\b|\s-d\b.*\s(?:-f|--force)\b)`)),
    destructive: true,
    reason: "git branch -D",
  },
  { test: re(new RegExp(String.raw`${GIT}.*\sstash\s+(?:drop|clear)\b`, "i")), destructive: true, reason: "git stash drop/clear" },
  {
    test: re(new RegExp(String.raw`${GIT}.*\s(?:filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire|gc\s+.*--prune)\b`, "i")),
    destructive: true,
    reason: "git history rewrite",
  },

  // Disks / system
  { test: re(/(?:^|\s)format(?:\.com)?\s+[a-z]:/i), destructive: true, reason: "disk format" },
  { test: re(at("Format-Volume|Clear-Disk|diskpart|fdisk|parted")), destructive: true, reason: "disk partitioning/format" },
  { test: re(/(?:^|\s)mkfs(?:\.\w+)?(?=\s|$)/i), destructive: true, reason: "filesystem creation (mkfs)" },
  { test: all(at("dd"), /\sof=/i), destructive: true, reason: "raw disk write (dd)" },
  { test: re(/>\s*\/dev\/(?:sd|hd|nvme|disk|mmcblk)/i), destructive: true, reason: "raw device write" },
  { test: re(at("shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer")), destructive: true, reason: "system shutdown/reboot" },
  { test: all(at("chmod"), /\s(?:-[a-zA-Z]*R|--recursive)\b/, /\b0?777\b|a\+rwx/), destructive: true, reason: "chmod -R 777" },
  { test: all(at("chown"), /\s(?:-[a-zA-Z]*R|--recursive)\b/), destructive: true, reason: "recursive chown" },

  // Data
  { test: re(/\bdrop\s+(?:table|database|schema)\b/i), destructive: true, reason: "SQL DROP" },
  { test: re(/\btruncate\s+table\b/i), destructive: true, reason: "SQL TRUNCATE" },
  { test: re(/\bdelete\s+from\s+[\w."`[\]]+\s*(?:;|$|["'])/i), destructive: true, reason: "SQL DELETE without WHERE" },

  // Publishing
  { test: re(/\b(?:npm|pnpm|yarn|bun)\s+(?:.*\s)?(?:publish|unpublish)\b/i), destructive: true, network: true, reason: "package publish" },

  // Network
  { test: re(at("curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Start-BitsTransfer")), network: true, reason: "HTTP download" },
  { test: re(at("ssh|scp|sftp|rsync|ftp|telnet|nc|ncat")), network: true, reason: "remote shell/file transfer" },
  { test: re(/Net\.WebClient|certutil(?:\.exe)?\s+.*-urlcache/i), network: true, reason: "HTTP download" },
  {
    test: re(/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|update|upgrade|up|dlx|x|create|init)\b/i),
    network: true,
    reason: "package install (network)",
  },
  { test: re(/(?:^|[\s"'])yarn\s*$/i), network: true, reason: "package install (network)" },
  { test: re(at("npx|pnpx|bunx")), network: true, reason: "npx may download packages" },
  { test: re(/\bpip3?\s+install\b|\bgo\s+(?:get|install)\b|\bcargo\s+install\b/i), network: true, reason: "package install (network)" },
  {
    test: re(new RegExp(String.raw`${GIT}.*\s(?:fetch|pull|push|clone|ls-remote|remote\s+update|submodule\s+update)\b`, "i")),
    network: true,
    reason: "git remote operation",
  },
  { test: re(/\bdocker\s+(?:pull|push|login)\b/i), network: true, reason: "container registry access" },
];

const SHELLS = String.raw`(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|iex|Invoke-Expression|powershell(?:\.exe)?|pwsh|python\d?|node|perl|ruby)`;

const WHOLE_RULES: Rule[] = [
  {
    test: re(new RegExp(String.raw`\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*${SHELLS}\b`, "i")),
    destructive: true,
    network: true,
    reason: "remote script piped into a shell",
  },
  {
    test: re(/(?:\$\(|<\(|`)\s*(?:curl|wget)\b|\b(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+Net\.WebClient)/i),
    destructive: true,
    network: true,
    reason: "remote script executed",
  },
];

/** Splits on shell chaining operators (&&, ||, ;, |, &, newlines). Over-splitting is acceptable. */
export function splitCommandChain(command: string): string[] {
  return command
    .split(/&&|\|\||\|&|[;|&\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function classifyCommand(command: string): CommandClassification {
  const reasons = new Set<string>();
  let destructive = false;
  let network = false;
  const apply = (rule: Rule, s: string) => {
    if (!rule.test(s)) return;
    if (rule.destructive) destructive = true;
    if (rule.network) network = true;
    reasons.add(typeof rule.reason === "function" ? rule.reason(s) : rule.reason);
  };
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const rule of WHOLE_RULES) apply(rule, normalized);
  for (const segment of splitCommandChain(command)) {
    const s = segment.replace(/\s+/g, " ");
    for (const rule of SEGMENT_RULES) apply(rule, s);
  }
  return { destructive, network, reasons: [...reasons] };
}
