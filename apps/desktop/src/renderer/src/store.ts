import { create } from "zustand";
import type { ApprovalDto, EventDto, FigmaStatusDto, ProjectSummary, RunStateDto } from "../../shared/ipc.js";
import { api, errorMessage } from "./api.js";

export type Screen =
  | { name: "projects" }
  | { name: "project"; projectId: string }
  | { name: "new-run"; projectId: string }
  | { name: "run"; projectId: string; runId: string; nodeId?: string }
  | { name: "matrix"; projectId: string; runId: string }
  | { name: "accounts" }
  | { name: "usage" }
  /** `step`: "<workflowId>/<nodeId>" to scroll to. */
  | { name: "skills"; step?: string }
  | { name: "workflows" }
  | { name: "workflow"; workflowId: string }
  | { name: "prompts"; workflowId?: string; nodeId?: string }
  | { name: "settings" };

interface AppState {
  screen: Screen;
  projects: ProjectSummary[];
  runStates: Record<string, RunStateDto>;
  runEvents: Record<string, EventDto[]>;
  approvals: ApprovalDto[];
  figma?: FigmaStatusDto;
  toast?: { kind: "error" | "info"; message: string };
  /** Flo, the floating mascot window, is shown (undefined until settings load). */
  floVisible?: boolean;
  navigate(screen: Screen): void;
  notify(kind: "error" | "info", message: string): void;
  clearToast(): void;
  refreshProjects(): Promise<void>;
  loadRun(runId: string): Promise<void>;
  refreshApprovals(): Promise<void>;
  setFloVisible(visible: boolean): Promise<void>;
}

const MAX_EVENTS_PER_RUN = 8000;

export const useApp = create<AppState>((set, get) => ({
  screen: { name: "projects" },
  projects: [],
  runStates: {},
  runEvents: {},
  approvals: [],
  navigate: (screen) => set({ screen }),
  notify: (kind, message) => set({ toast: { kind, message } }),
  clearToast: () => set({ toast: undefined }),
  async refreshProjects() {
    try {
      set({ projects: await api.invoke("projects:list") });
    } catch (err) {
      get().notify("error", errorMessage(err));
    }
  },
  async loadRun(runId) {
    try {
      const [state, events] = await Promise.all([api.invoke("runs:get", { runId }), api.invoke("runs:events", { runId, limit: 5000 })]);
      set((s) => ({ runStates: { ...s.runStates, [runId]: state }, runEvents: { ...s.runEvents, [runId]: events } }));
    } catch (err) {
      get().notify("error", errorMessage(err));
    }
  },
  async refreshApprovals() {
    try {
      set({ approvals: await api.invoke("approvals:list") });
    } catch (err) {
      get().notify("error", errorMessage(err));
    }
  },
  async setFloVisible(visible) {
    // Set first, so the push that follows is not mistaken for Flo hiding itself.
    set({ floVisible: visible });
    try {
      set({ floVisible: (await api.invoke("settings:update", { showFlo: visible })).showFlo });
    } catch (err) {
      set({ floVisible: !visible });
      get().notify("error", errorMessage(err));
    }
  },
}));

let wired = false;
/** Subscribes once to main-process push channels. */
export function wirePushEvents(): void {
  if (wired) return;
  wired = true;
  api.on("run:state", (state) => {
    useApp.setState((s) => ({ runStates: { ...s.runStates, [state.run.id]: state } }));
  });
  // Agent events reach run:event through the engine; session:event is only for the Sessions screen.
  api.on("run:event", (event) => appendEvent(event));
  api.on("figma:status", (figma) => useApp.setState({ figma }));
  api.on("approval:requested", () => void useApp.getState().refreshApprovals());
  // Flo's card was clicked in its floating window.
  api.on("flo:open", ({ projectId, runId, nodeId }) => useApp.getState().navigate({ name: "run", projectId, runId, ...(nodeId ? { nodeId } : {}) }));
  api.on("flo:visibility", ({ visible }) => {
    const hidBySelf = !visible && useApp.getState().floVisible === true;
    useApp.setState({ floVisible: visible });
    if (hidBySelf) useApp.getState().notify("info", "Flo is hidden. Show it again with Show Flo in the sidebar.");
  });
}

function appendEvent(event: EventDto): void {
  useApp.setState((s) => {
    const list = s.runEvents[event.workflowRunId] ?? [];
    const next = list.length >= MAX_EVENTS_PER_RUN ? [...list.slice(-MAX_EVENTS_PER_RUN + 1), event] : [...list, event];
    return { runEvents: { ...s.runEvents, [event.workflowRunId]: next } };
  });
}
