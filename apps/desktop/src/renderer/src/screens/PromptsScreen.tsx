import { useEffect, useMemo, useState } from "react";
import type { NodeTypeDto, WorkflowDto, WorkflowSummaryDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { PromptEditor } from "../components/PromptEditor.js";
import { lanesOf, laneFor } from "../lib/groups.js";

const FEATURE_DELIVERY = "feature-delivery";

/**
 * Every prompt of a workflow in one place: the prompt of each step (the same in every project), the
 * system prompt every AI step runs with, and — for a chosen project — its own additions to a step.
 */
export function PromptsScreen({ workflowId: initialWorkflow, nodeId: initialNode }: { workflowId?: string; nodeId?: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const projects = useApp((s) => s.projects);
  const refreshProjects = useApp((s) => s.refreshProjects);
  const [workflows, setWorkflows] = useState<WorkflowSummaryDto[]>();
  const [nodeTypes, setNodeTypes] = useState<NodeTypeDto[]>([]);
  const [workflowId, setWorkflowId] = useState(initialWorkflow ?? FEATURE_DELIVERY);
  const [workflow, setWorkflow] = useState<WorkflowDto>();
  const [nodeId, setNodeId] = useState(initialNode);
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    void refreshProjects();
    api.invoke("workflows:list").then(
      (s) => {
        setWorkflows(s.workflows);
        setNodeTypes(s.nodeTypes);
      },
      (err) => notify("error", errorMessage(err)),
    );
  }, [notify, refreshProjects]);

  async function loadWorkflow() {
    try {
      setWorkflow(await api.invoke("workflows:get", { workflowId }));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  useEffect(() => {
    setWorkflow(undefined);
    void loadWorkflow();
  }, [workflowId]);

  const steps = useMemo(() => {
    if (!workflow) return [];
    const withPrompt = new Set(nodeTypes.filter((t) => t.prompt).map((t) => t.type));
    const lanes = lanesOf(workflow.lanes, workflow.nodes);
    return lanes.flatMap((lane) => workflow.nodes.filter((n) => withPrompt.has(n.type) && laneFor(lanes, n)?.id === lane.id).map((n) => ({ node: n, lane })));
  }, [workflow, nodeTypes]);

  useEffect(() => {
    if (steps.length && !steps.some((s) => s.node.id === nodeId)) setNodeId(steps[0]?.node.id);
  }, [steps]);

  if (!workflows) return <Loading label="Loading prompts" screen />;
  const selected = steps.find((s) => s.node.id === nodeId);

  return (
    <div className="ff-screen">
      <header className="ff-screen-header">
        <div>
          <span className="ff-eyebrow">Workspace</span>
          <h1>Prompts</h1>
          <p className="ff-muted">
            Each AI step runs its prompt; a manual check shows its prompt as the checklist. A step&apos;s prompt is the same in every project; choose a project to add instructions only that
            project needs.
          </p>
        </div>
      </header>

      <div className="ff-row ff-prompts-bar">
        <label className="ff-field ff-inline">
          <span>Workflow</span>
          <select className="ff-input" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ff-field ff-inline">
          <span>Project additions for</span>
          <select className="ff-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No project (step prompts only)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <span className="ff-grow" />
        <button type="button" className="ff-btn" onClick={() => navigate({ name: "workflow", workflowId })}>
          Open workflow
        </button>
      </div>

      {!workflow ? (
        <Loading label="Loading workflow" />
      ) : (
        <div className="ff-skills">
          <nav className="ff-skills-list" aria-label="Steps with a prompt">
            <ul className="ff-list">
              {steps.map(({ node, lane }) => (
                <li key={node.id}>
                  <button
                    type="button"
                    className={`ff-skill-item${node.id === nodeId ? " ff-skill-item-active" : ""}`}
                    aria-current={node.id === nodeId ? "true" : undefined}
                    onClick={() => setNodeId(node.id)}
                  >
                    <span className="ff-skill-item-head">
                      <span className="ff-row">
                        <span className="ff-lane-dot" style={{ background: lane.color }} />
                        <strong>{node.label}</strong>
                      </span>
                      {workflow.missingPrompts.includes(node.id) ? <span className="ff-tag ff-tag-warn">⚠ no prompt</span> : null}
                    </span>
                    <span className="ff-skill-item-desc">
                      {lane.title} · {nodeTypes.find((t) => t.type === node.type)?.label ?? node.type}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {steps.length ? null : <p className="ff-muted ff-small">This workflow has no step with a prompt.</p>}
          </nav>
          {selected ? (
            <section className="ff-card ff-prompts-editor" aria-label={`Prompt of ${selected.node.label}`}>
              <PromptEditor
                key={`${workflowId}/${selected.node.id}/${projectId}`}
                workflowId={workflowId}
                nodeId={selected.node.id}
                nodeType={selected.node.type}
                label={selected.node.label}
                {...(projectId ? { projectId } : {})}
                onSaved={() => void loadWorkflow()}
              />
            </section>
          ) : (
            <div className="ff-empty ff-empty-inline">
              <p>Select a step to edit its prompt.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
