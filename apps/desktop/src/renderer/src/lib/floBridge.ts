import { floFocus } from "@frontflow/ui-components";
import type { FloStateDto, RunStateDto } from "../../../shared/ipc.js";
import { api } from "../api.js";
import { useApp } from "../store.js";
import { TERMINAL, latestNodeRuns } from "../screens/RunScreen.js";
import { buildActivity, lastActivityByNode } from "./activity.js";

type AppSnapshot = ReturnType<typeof useApp.getState>;

/** Flo follows the run on screen, else the newest active run, else the newest run this window knows. */
function followedRun(s: AppSnapshot): RunStateDto | undefined {
  if (s.screen.name === "run" || s.screen.name === "matrix") {
    const open = s.runStates[s.screen.runId];
    if (open) return open;
  }
  const runs = Object.values(s.runStates).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  return runs.find((r) => !TERMINAL.has(r.run.status)) ?? runs[0];
}

function floState(s: AppSnapshot): FloStateDto {
  const state = followedRun(s);
  if (!state) return { mood: "idle", title: "FrontFlow", detail: "No run in progress" };
  const { run, nodeRuns, graph } = state;
  const latest = latestNodeRuns(nodeRuns);
  const focus = floFocus(
    run.status,
    graph.nodes.map((n) => ({ id: n.id, type: n.type, status: latest.get(n.id)?.status })),
  );
  const node = graph.nodes.find((n) => n.id === focus.nodeId);
  const lines = buildActivity(s.runEvents[run.id] ?? [], nodeRuns);
  const detail = node ? lastActivityByNode(lines).get(node.id)?.text : lines[lines.length - 1]?.text;
  return {
    mood: focus.mood,
    title: (node?.label ?? run.title ?? run.workflowId).slice(0, 200),
    ...(detail ? { detail: detail.slice(0, 600) } : {}),
    target: { projectId: run.projectId, runId: run.id, ...(node ? { nodeId: node.id } : {}) },
  };
}

let wired = false;
/** Keeps Flo's window (main/flo-window.ts) in step with this window's runs, at most a few times a second. */
export function wireFlo(): void {
  if (wired) return;
  wired = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent = "";
  const push = () => {
    timer = undefined;
    const next = floState(useApp.getState());
    const key = JSON.stringify(next);
    if (key === sent) return;
    sent = key;
    api.invoke("flo:update", next).catch(() => {
      // Retried with the next change.
      sent = "";
    });
  };
  useApp.subscribe(() => {
    timer ??= setTimeout(push, 300);
  });
  push();
  void api.invoke("settings:get").then(
    (s) => useApp.setState({ floVisible: s.showFlo }),
    () => undefined,
  );
}
