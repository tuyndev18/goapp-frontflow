import { useEffect, useState } from "react";
import { useApp, wirePushEvents } from "./store.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { ProjectOverview } from "./screens/ProjectOverview.js";
import { NewFeatureRun } from "./screens/NewFeatureRun.js";
import { RunScreen } from "./screens/RunScreen.js";
import { TraceabilityMatrix } from "./screens/TraceabilityMatrix.js";
import { AccountsScreen } from "./screens/AccountsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { SkillsScreen } from "./screens/SkillsScreen.js";
import { UsageScreen } from "./screens/UsageScreen.js";
import { WorkflowsScreen } from "./screens/WorkflowsScreen.js";
import { WorkflowEditor } from "./screens/WorkflowEditor.js";
import { PromptsScreen } from "./screens/PromptsScreen.js";
import { AccountsBubble } from "./components/AccountsBubble.js";
import { ClaudeCodeLauncher } from "./components/ClaudeCodeLauncher.js";
import { ApprovalsBar } from "./components/ApprovalsBar.js";
import { BrandMark } from "./components/BrandMark.js";
import { NavIcon, type NavIconName } from "./components/NavIcon.js";
import { setThemePreference, useTheme, type ThemePreference } from "./lib/theme.js";

export function App() {
  const screen = useApp((s) => s.screen);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const clearToast = useApp((s) => s.clearToast);
  const projectId = "projectId" in screen ? screen.projectId : undefined;
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const runTitle = useApp((s) => (screen.name === "run" || screen.name === "matrix" ? s.runStates[screen.runId]?.run.title : undefined));
  // Always starts collapsed to icons; it only expands when the user asks, and that is not remembered.
  const [collapsed, setCollapsed] = useState(true);

  function toggleSidebar() {
    setCollapsed((c) => !c);
  }

  // Ctrl+\ (Cmd+\ on macOS) toggles the sidebar, as in Linear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    wirePushEvents();
    void useApp.getState().refreshApprovals();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 6000);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  return (
    <div className={`ff-app${collapsed ? " ff-app-collapsed" : ""}`}>
      <nav className="ff-sidebar" aria-label="Main navigation">
        <div className="ff-brand">
          <BrandMark />
          <div className="ff-brand-text">
            <strong>GoApp FrontFlow</strong>
            <small>Spec &amp; design → verified frontend</small>
          </div>
          <button
            type="button"
            className="ff-sidebar-toggle"
            onClick={toggleSidebar}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+\\)`}
          >
            <NavIcon name={collapsed ? "expand" : "collapse"} />
          </button>
        </div>
        <div className="ff-nav-section">
          <NavButton active={screen.name === "projects"} onClick={() => navigate({ name: "projects" })} icon="projects">
            Projects
          </NavButton>
          <NavButton active={screen.name === "accounts"} onClick={() => navigate({ name: "accounts" })} icon="accounts">
            Accounts
          </NavButton>
          <NavButton active={screen.name === "usage"} onClick={() => navigate({ name: "usage" })} icon="usage">
            Usage
          </NavButton>
          <NavButton active={screen.name === "workflows" || screen.name === "workflow"} onClick={() => navigate({ name: "workflows" })} icon="workflows">
            Workflows
          </NavButton>
          <NavButton active={screen.name === "prompts"} onClick={() => navigate({ name: "prompts" })} icon="prompts">
            Prompts
          </NavButton>
          <NavButton active={screen.name === "skills"} onClick={() => navigate({ name: "skills" })} icon="skills">
            Skills
          </NavButton>
        </div>
        {projectId ? (
          <div className="ff-nav-section">
            <span className="ff-nav-heading">Current project</span>
            <span className="ff-nav-project ff-ellipsis" title={project?.rootPath}>
              {project?.name ?? "Project"}
            </span>
            <NavButton active={screen.name === "project"} onClick={() => navigate({ name: "project", projectId })} icon="overview">
              Project overview
            </NavButton>
            <NavButton active={screen.name === "new-run"} onClick={() => navigate({ name: "new-run", projectId })} icon="plus">
              New feature
            </NavButton>
            {(screen.name === "run" || screen.name === "matrix") && (
              <NavButton active={screen.name === "run"} onClick={() => navigate({ name: "run", projectId, runId: screen.runId })} icon="run" sub>
                {runTitle ?? "Current run"}
              </NavButton>
            )}
          </div>
        ) : null}
        <div className="ff-nav-section ff-nav-bottom">
          <NavButton active={screen.name === "settings"} onClick={() => navigate({ name: "settings" })} icon="settings">
            Settings
          </NavButton>
          <ThemeSwitcher />
        </div>
      </nav>
      <main className="ff-main">
        <ApprovalsBar />
        {screen.name === "projects" && <ProjectsScreen />}
        {screen.name === "project" && <ProjectOverview projectId={screen.projectId} />}
        {screen.name === "new-run" && <NewFeatureRun projectId={screen.projectId} />}
        {screen.name === "run" && <RunScreen key={screen.runId} projectId={screen.projectId} runId={screen.runId} {...(screen.nodeId ? { initialNodeId: screen.nodeId } : {})} />}
        {screen.name === "matrix" && <TraceabilityMatrix projectId={screen.projectId} runId={screen.runId} />}
        {screen.name === "accounts" && <AccountsScreen />}
        {screen.name === "usage" && <UsageScreen />}
        {screen.name === "skills" && <SkillsScreen {...(screen.step ? { focusStep: screen.step } : {})} />}
        {screen.name === "workflows" && <WorkflowsScreen />}
        {screen.name === "workflow" && <WorkflowEditor key={screen.workflowId} workflowId={screen.workflowId} />}
        {screen.name === "prompts" && <PromptsScreen {...(screen.workflowId ? { workflowId: screen.workflowId } : {})} {...(screen.nodeId ? { nodeId: screen.nodeId } : {})} />}
        {screen.name === "settings" && <SettingsScreen />}
      </main>
      {screen.name !== "accounts" && <AccountsBubble />}
      {screen.name === "run" && <ClaudeCodeLauncher key={screen.runId} runId={screen.runId} />}
      {toast ? (
        <div className={`ff-toast ff-toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <span>{toast.message}</span>
          <button type="button" onClick={clearToast} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: "light", label: "Light", icon: "☀" },
  { value: "dark", label: "Dark", icon: "☾" },
  { value: "system", label: "System", icon: "◐" },
];

function ThemeSwitcher() {
  const { preference } = useTheme();
  const current = THEME_OPTIONS.find((o) => o.value === preference) ?? THEME_OPTIONS[2]!;
  const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(current) + 1) % THEME_OPTIONS.length]!;
  return (
    <div className="ff-theme-switch">
      {/* Collapsed sidebar: one button cycling light → dark → system. */}
      <button type="button" className="ff-theme-cycle" onClick={() => setThemePreference(next.value)} title={`Theme: ${current.label} (switch to ${next.label})`} aria-label={`Theme: ${current.label}`}>
        {current.icon}
      </button>
      <span className="ff-theme-label">Appearance</span>
      <div className="ff-seg" role="radiogroup" aria-label="Color theme">
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={preference === o.value}
            className={`ff-seg-btn${preference === o.value ? " ff-seg-active" : ""}`}
            onClick={() => setThemePreference(o.value)}
            title={o.value === "system" ? "Follow the operating system" : `${o.label} mode`}
          >
            <span aria-hidden="true">{o.icon}</span> {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NavButton({ active, onClick, sub, icon, children }: { active: boolean; onClick(): void; sub?: boolean; icon: NavIconName; children: string }) {
  return (
    <button
      type="button"
      className={`ff-nav${sub ? " ff-nav-sub" : ""}${active ? " ff-nav-active" : ""}`}
      aria-current={active ? "page" : undefined}
      title={children}
      onClick={onClick}
    >
      <NavIcon name={icon} />
      <span className="ff-nav-label">{children}</span>
    </button>
  );
}
