import { useEffect, useState } from "react";
import type { AppInfo, CliStatus, FigmaStatusDto, SettingsDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";

export function SettingsScreen() {
  const notify = useApp((s) => s.notify);
  const [settings, setSettings] = useState<SettingsDto>();
  const [info, setInfo] = useState<AppInfo>();
  const [clis, setClis] = useState<CliStatus[]>([]);
  const [figma, setFigma] = useState<FigmaStatusDto>();
  const [serverPath, setServerPath] = useState("");

  useEffect(() => {
    void Promise.all([api.invoke("settings:get"), api.invoke("app:info"), api.invoke("clis:detect"), api.invoke("figma:status")]).then(
      ([s, i, c, f]) => {
        setSettings(s);
        setServerPath(s.goFigmaServerPath);
        setInfo(i);
        setClis(c);
        setFigma(f);
      },
      (err) => notify("error", errorMessage(err)),
    );
    return api.on("figma:status", setFigma);
  }, [notify]);

  async function update(patch: Partial<SettingsDto>) {
    try {
      setSettings(await api.invoke("settings:update", patch));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  if (!settings) return <div className="ff-screen">Loading…</div>;
  return (
    <div className="ff-screen ff-screen-narrow">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>Settings</h1>
          <p className="ff-muted">AI engine, design hand-off, security and data retention. Changes save immediately.</p>
        </div>
      </header>
      <div className="ff-settings">
        <section className="ff-card">
          <h2>AI engine</h2>
          <div className="ff-setting">
            <div className="ff-setting-text">
              <label htmlFor="set-adapter">Default adapter</label>
              <p>The AI CLI that runs workflow steps.</p>
            </div>
            <select id="set-adapter" className="ff-input" value={settings.defaultAdapterId} onChange={(e) => void update({ defaultAdapterId: e.target.value })}>
              {clis.map((c) => (
                <option key={c.adapterId} value={c.adapterId}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ff-setting">
            <div className="ff-setting-text">
              <label htmlFor="set-concurrency">AI sessions running at once</label>
              <p>Keep this low on a Claude/ChatGPT subscription. A run pauses by itself when the CLI reports a usage limit.</p>
            </div>
            <input
              id="set-concurrency"
              className="ff-input"
              type="number"
              min={1}
              max={8}
              value={settings.maxConcurrentNodes}
              onChange={(e) => void update({ maxConcurrentNodes: Number(e.target.value) })}
            />
          </div>
          <div className="ff-setting ff-setting-check">
            <label className="ff-checkbox">
              <input type="checkbox" checked={settings.interactiveAgents} onChange={(e) => void update({ interactiveAgents: e.target.checked })} />
              <span>
                Run Claude Code steps as interactive sessions in the project folder (watch and answer them in AI terminals) instead of headless <span className="ff-mono">claude -p</span>
              </span>
            </label>
          </div>
          <h3>Installed adapters</h3>
          <table className="ff-table ff-table-compact">
            <thead>
              <tr>
                <th scope="col">Adapter</th>
                <th scope="col">Installed</th>
                <th scope="col">Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {clis.map((c) => (
                <tr key={c.adapterId}>
                  <td>{c.label}</td>
                  <td>{c.installed ? `✓ ${c.version ?? ""}` : "✕"}</td>
                  <td className="ff-small">
                    {Object.entries(c.capabilities ?? {})
                      .filter(([, v]) => v)
                      .map(([k]) => k)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="ff-card">
          <div className="ff-card-head">
            <h2>GoApp Figma</h2>
            <span className={`ff-tag ${figma?.listening ? "ff-tag-ok" : ""}`}>{figma?.listening ? "● Listening" : "○ Not connected to the hub yet"}</span>
          </div>
          <p className="ff-muted ff-small">
            The plugin&apos;s FrontFlow button pushes the selected frames through this MCP server&apos;s hub, and the AI CLI gets the same server to read the design.
          </p>
          <label className="ff-field">
            <span>MCP server (go-figma dist/mcp.mjs)</span>
            <input
              className="ff-input ff-mono"
              placeholder={figma?.source === "detected" ? figma.serverPath : "Empty = the goapp-figma entry in Claude Code / Codex / Cursor"}
              value={serverPath}
              onChange={(e) => setServerPath(e.target.value)}
              onBlur={() => serverPath !== settings.goFigmaServerPath && void update({ goFigmaServerPath: serverPath.trim() })}
              aria-label="GoApp Figma MCP server path"
            />
          </label>
          {figma?.error ? (
            <p className="ff-error">⚠ {figma.error}</p>
          ) : figma?.serverPath ? (
            <p>
              ✓ {figma.source === "detected" ? "Found in an agent config" : "Using"}: <span className="ff-mono ff-small">{figma.serverPath}</span>
            </p>
          ) : (
            <p>⚠ Not found. Build go-figma and add it to Claude Code from the plugin&apos;s MCP panel, or enter the path above.</p>
          )}
        </section>

        <section className="ff-card">
          <h2>Security</h2>
          <div className="ff-setting ff-setting-check">
            <label className="ff-checkbox">
              <input type="checkbox" checked={settings.allowArbitraryShell} onChange={(e) => void update({ allowArbitraryShell: e.target.checked })} />
              <span>Allow AI-proposed shell commands outside project scripts (still logged; destructive actions always need approval)</span>
            </label>
          </div>
        </section>

        <section className="ff-card">
          <h2>Data &amp; retention</h2>
          <div className="ff-setting">
            <div className="ff-setting-text">
              <label htmlFor="set-retention">Keep logs and screenshots for (days)</label>
              <p>Older run logs and screenshots are removed automatically.</p>
            </div>
            <input
              id="set-retention"
              className="ff-input"
              type="number"
              min={1}
              max={365}
              value={settings.retentionDays}
              onChange={(e) => void update({ retentionDays: Number(e.target.value) })}
            />
          </div>
          <div className="ff-setting ff-setting-check">
            <label className="ff-checkbox">
              <input type="checkbox" checked={settings.rawTerminalLogs} onChange={(e) => void update({ rawTerminalLogs: e.target.checked })} />
              <span>Store raw terminal logs (redacted)</span>
            </label>
          </div>
          {info ? (
            <p className="ff-muted ff-small ff-app-info">
              {info.name} {info.version} · {info.platform} · data: <span className="ff-mono">{info.dataDir}</span>
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
