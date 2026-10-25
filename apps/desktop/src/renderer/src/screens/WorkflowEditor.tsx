import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import type { GraphEdgeDto, GraphNodeDto, LaneDto, NodeTypeDto, PromptDto, SkillsStateDto, WorkflowDto, WorkflowNodeDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { Loading } from "../components/Loading.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { laneFor, lanesOf, nodeColor, type Lane } from "../lib/groups.js";
import { stepLook } from "../lib/steps.js";
import { useTheme } from "../lib/theme.js";
import { LANE_LABEL_W, LANE_PAD_Y, LaneHeaders, LaneNode, layout, NODE_H, NODE_W, type LaneBox, type LaneData } from "./GraphView.js";

const STEP_MIME = "application/x-frontflow-step";
// SVG marker colours are attributes, so literal hex (the same as the run canvas and --color-primary).
const EDGE_COLOR = "#8a8f98";
const EDGE_SELECTED = "#5e6ad2";
/** The editor never shrinks steps below a readable size: a big workflow is panned instead. */
const EDITOR_FIT = { padding: { top: "64px", right: "24px", bottom: "40px", left: "24px" }, minZoom: 0.6, maxZoom: 1 } as const;
/** Width of the drawer, which floats over the right of the canvas (see .ff-wf-drawer). */
const DRAWER_MAX = 520;
const GRID = 8;
/** What the generic steps fill in (see workflow-nodes handlers/generic.ts). */
const GENERIC_PLACEHOLDERS: Record<string, string[]> = {
  "ai.prompt": ["feature", "runFolder", "output", "reports"],
  "manual.check": ["feature", "runFolder", "reports"],
};

type Draft = Pick<WorkflowDto, "name" | "lanes" | "nodes"> & { description: string };
type Selection = { kind: "node" | "edge"; id: string } | undefined;
type Drawer = { kind: "node"; tab: NodeTab } | { kind: "workflow" } | { kind: "problems" } | undefined;
type NodeTab = "settings" | "prompt" | "skills";
/** A step's prompt as loaded (`saved`) and as edited in the editor (`text`). */
interface PromptState {
  saved: PromptDto;
  text: string;
}
interface Problem {
  nodeId?: string;
  text: string;
  tab?: NodeTab;
}

interface EditorNodeData extends Record<string, unknown> {
  node: WorkflowNodeDto;
  info?: NodeTypeDto;
  color: string;
  selected: boolean;
  /** Problems shown on the card (missing prompt, missing input steps). */
  warnings: string[];
  editable: boolean;
}

const toDraft = (w: WorkflowDto): Draft => ({ name: w.name, description: w.description ?? "", lanes: w.lanes, nodes: w.nodes });
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Visual workflow editor. Lanes are the rows of the canvas: drag a step type from the toolbar onto
 * a lane to add it, drag steps anywhere (into another lane too), and pull a step's right dot onto
 * another step so that one waits for it. Selecting a step opens its drawer: settings, prompt,
 * skills. One Save writes the workflow and every edited prompt. Built-in workflows are read-only
 * (clone them); their prompts can still be edited here.
 */
export function WorkflowEditor({ workflowId }: { workflowId: string }) {
  const navigate = useApp((s) => s.navigate);
  const notify = useApp((s) => s.notify);
  const [saved, setSaved] = useState<WorkflowDto>();
  const [draft, setDraft] = useState<Draft>();
  const [nodeTypes, setNodeTypes] = useState<NodeTypeDto[]>([]);
  const [prompts, setPrompts] = useState<Record<string, PromptState>>({});
  const [selection, setSelection] = useState<Selection>();
  const [drawer, setDrawer] = useState<Drawer>();
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "leave" | "remove-node">();

  useEffect(() => {
    Promise.all([api.invoke("workflows:get", { workflowId }), api.invoke("workflows:list")]).then(
      ([w, list]) => {
        setSaved(w);
        setDraft(toDraft(w));
        setNodeTypes(list.nodeTypes);
      },
      (err) => notify("error", errorMessage(err)),
    );
  }, [workflowId, notify]);

  const promptTypes = useMemo(() => new Set(nodeTypes.filter((t) => t.prompt).map((t) => t.type)), [nodeTypes]);

  // Every step with a prompt gets it loaded once, so missing prompts show while editing.
  useEffect(() => {
    if (!draft) return;
    const missing = draft.nodes.filter((n) => promptTypes.has(n.type) && !prompts[n.id]).map((n) => n.id);
    for (const id of missing) {
      api.invoke("prompts:get", { workflowId, name: id }).then(
        (p) => setPrompts((all) => (all[id] ? all : { ...all, [id]: { saved: p, text: p.text } })),
        () => undefined,
      );
    }
  }, [draft?.nodes, promptTypes, workflowId]);

  const editable = saved ? !saved.builtin : false;
  const structureDirty = !!saved && !!draft && !sameDraft(toDraft(saved), draft);
  const nodeIds = new Set(draft?.nodes.map((n) => n.id));
  const changedPrompts = Object.entries(prompts).filter(([id, p]) => nodeIds.has(id) && p.text !== p.saved.text);
  const dirty = structureDirty || changedPrompts.length > 0;

  const problems = useMemo<Problem[]>(() => {
    if (!draft) return [];
    const ancestors = ancestorMap(draft.nodes);
    return draft.nodes.flatMap((n): Problem[] => {
      const info = nodeTypes.find((t) => t.type === n.type);
      const out: Problem[] = [];
      if (!n.label.trim()) out.push({ nodeId: n.id, text: "has no name", tab: "settings" });
      if (info?.prompt && prompts[n.id] && !prompts[n.id]?.text.trim()) out.push({ nodeId: n.id, text: "has no prompt: features cannot start this workflow", tab: "prompt" });
      for (const need of info?.needs ?? []) {
        if (!ancestors.get(n.id)?.has(need)) out.push({ nodeId: n.id, text: `reads ${draft.nodes.find((x) => x.id === need)?.label ?? need}: make it run after that step`, tab: "settings" });
      }
      return out;
    });
  }, [draft, nodeTypes, prompts]);

  const change = useCallback((fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d)), []);
  const readOnly = saved?.builtin ?? true;
  const select = useCallback(
    (s: Selection, tab?: NodeTab) => {
      setSelection(s);
      // A read-only step only has its prompt (and skills) to edit: open on it.
      if (s?.kind === "node") setDrawer({ kind: "node", tab: tab ?? (readOnly ? "prompt" : "settings") });
      else setDrawer((d) => (d?.kind === "node" ? undefined : d));
    },
    [readOnly],
  );

  async function save() {
    if (!draft || !saved) return;
    setBusy(true);
    try {
      let next = saved;
      if (structureDirty && editable) {
        next = await api.invoke("workflows:save", {
          workflow: { id: saved.id, name: draft.name.trim(), ...(draft.description.trim() ? { description: draft.description.trim() } : {}), lanes: draft.lanes, nodes: draft.nodes },
        });
      }
      const updated: Record<string, PromptState> = {};
      for (const [id, p] of changedPrompts) {
        if (!p.text.trim()) continue;
        // Back to the shipped text: drop the edit instead of storing a copy of the default.
        const result =
          p.saved.defaultText && p.text === p.saved.defaultText
            ? await api.invoke("prompts:reset", { workflowId, name: id })
            : await api.invoke("prompts:save", { workflowId, name: id, text: p.text });
        updated[id] = { saved: result, text: result.text };
      }
      setPrompts((all) => ({ ...all, ...updated }));
      if (Object.keys(updated).length) next = await api.invoke("workflows:get", { workflowId });
      setSaved(next);
      setDraft(toDraft(next));
      setServerIssues([]);
      notify("info", structureDirty && editable ? `Saved ${next.name} (v${next.version})` : "Prompts saved");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "INVALID_WORKFLOW") {
        setServerIssues(errorMessage(err).split("; "));
        setDrawer({ kind: "problems" });
      }
      notify("error", code === "INVALID_WORKFLOW" ? "The workflow cannot be saved: see Problems" : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cloneBuiltin() {
    if (!saved) return;
    try {
      const w = await api.invoke("workflows:create", { name: `${saved.name} (copy)`, fromId: saved.id });
      navigate({ name: "workflow", workflowId: w.id });
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }

  if (!saved || !draft) return <Loading label="Loading workflow" screen />;
  const selectedNode = selection?.kind === "node" ? draft.nodes.find((n) => n.id === selection.id) : undefined;
  const problemCount = problems.length + serverIssues.length;

  return (
    <div className="ff-wf-screen">
      <header className="ff-wf-bar">
        <button type="button" className="ff-back" onClick={() => (dirty ? setConfirm("leave") : navigate({ name: "workflows" }))}>
          ← Workflows
        </button>
        <div className="ff-wf-title">
          <h1>{draft.name || "Untitled workflow"}</h1>
          <span className="ff-muted ff-small">
            v{saved.version} · {draft.nodes.length} steps{saved.builtin ? " · built-in, read-only" : ""}
          </span>
        </div>
        <span className="ff-grow" />
        <button
          type="button"
          className={`ff-btn${problemCount ? " ff-btn-warn" : ""}`}
          aria-pressed={drawer?.kind === "problems"}
          onClick={() => setDrawer((d) => (d?.kind === "problems" ? undefined : { kind: "problems" }))}
        >
          {problemCount ? `⚠ ${problemCount} problem${problemCount === 1 ? "" : "s"}` : "✓ No problems"}
        </button>
        <button type="button" className="ff-btn" aria-pressed={drawer?.kind === "workflow"} onClick={() => setDrawer((d) => (d?.kind === "workflow" ? undefined : { kind: "workflow" }))}>
          {editable ? "Workflow & lanes" : "About"}
        </button>
        {saved.builtin ? (
          <button type="button" className="ff-btn" onClick={() => void cloneBuiltin()}>
            Clone to edit steps
          </button>
        ) : null}
        {dirty ? <span className="ff-tag ff-tag-warn">unsaved</span> : null}
        <button type="button" className="ff-btn" disabled={!dirty || busy} onClick={() => setConfirm("discard")}>
          Discard
        </button>
        <button type="button" className="ff-btn ff-btn-primary" disabled={!dirty || busy || !draft.name.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </header>
      {saved.builtin ? (
        <p className="ff-wf-note ff-muted ff-small">
          The built-in workflow&apos;s steps cannot change; click a step to edit its prompt or skills, or clone the workflow to change its steps.
        </p>
      ) : null}

      <div className="ff-wf-body">
        <ReactFlowProvider>
          <Canvas
            draft={draft}
            nodeTypes={nodeTypes}
            prompts={prompts}
            selection={selection}
            editable={editable}
            onSelect={select}
            onChange={change}
            onRemoveNode={() => setConfirm("remove-node")}
          />
        </ReactFlowProvider>

        {drawer ? (
          <aside className="ff-wf-drawer" aria-label="Inspector">
            {drawer.kind === "node" && selectedNode ? (
              <NodeDrawer
                workflowId={saved.id}
                node={selectedNode}
                draft={draft}
                tab={drawer.tab}
                info={nodeTypes.find((t) => t.type === selectedNode.type)}
                prompt={prompts[selectedNode.id]}
                saved={saved.nodes.some((n) => n.id === selectedNode.id)}
                editable={editable}
                onTab={(tab) => setDrawer({ kind: "node", tab })}
                onChange={change}
                onPrompt={(text) => setPrompts((all) => (all[selectedNode.id] ? { ...all, [selectedNode.id]: { ...all[selectedNode.id]!, text } } : all))}
                onRemove={() => setConfirm("remove-node")}
                onClose={() => select(undefined)}
              />
            ) : drawer.kind === "workflow" ? (
              <WorkflowDrawer draft={draft} editable={editable} onChange={change} onClose={() => setDrawer(undefined)} />
            ) : drawer.kind === "problems" ? (
              <ProblemsDrawer
                problems={problems}
                serverIssues={serverIssues}
                label={(id) => draft.nodes.find((n) => n.id === id)?.label ?? id}
                onOpen={(p) => p.nodeId && select({ kind: "node", id: p.nodeId }, p.tab)}
                onClose={() => setDrawer(undefined)}
              />
            ) : null}
          </aside>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm === "discard" || confirm === "leave"}
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (confirm === "leave") navigate({ name: "workflows" });
          else {
            setDraft(toDraft(saved));
            setPrompts((all) => Object.fromEntries(Object.entries(all).map(([id, p]) => [id, { ...p, text: p.saved.text }])));
            setServerIssues([]);
          }
          setConfirm(undefined);
        }}
      >
        <p>The changes to this workflow and its prompts since they were last saved are lost.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "remove-node"}
        title={`Remove ${selectedNode?.label ?? "this step"}?`}
        confirmLabel="Remove step"
        danger
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (selectedNode) change((d) => removeNode(d, selectedNode.id));
          select(undefined);
          setConfirm(undefined);
        }}
      >
        <p>The step and its links are removed from the workflow when you save it. Its prompt is kept in case you add the step back.</p>
      </ConfirmDialog>
    </div>
  );
}

function Canvas({
  draft,
  nodeTypes,
  prompts,
  selection,
  editable,
  onSelect,
  onChange,
  onRemoveNode,
}: {
  draft: Draft;
  nodeTypes: NodeTypeDto[];
  prompts: Record<string, PromptState>;
  selection: Selection;
  editable: boolean;
  onSelect(s: Selection, tab?: NodeTab): void;
  onChange(fn: (d: Draft) => Draft): void;
  onRemoveNode(): void;
}) {
  const { resolved: colorMode } = useTheme();
  const { screenToFlowPosition, flowToScreenPosition, setCenter, getZoom } = useReactFlow();
  const sectionRef = useRef<HTMLElement>(null);
  const lanes = useMemo(() => lanesOf(draft.lanes, draft.nodes), [draft.lanes, draft.nodes]);
  const graph = useMemo(() => toGraph(draft), [draft]);
  const { positions, lanes: boxes, width } = useMemo(() => layout(graph, lanes, { emptyLanes: true }), [graph, lanes]);
  const [rfNodes, setRfNodes] = useState<Node<EditorNodeData | LaneData>[]>([]);
  const canvasWidth = Math.max(width, LANE_LABEL_W + 4 * (NODE_W + 100));
  const placedRef = useRef<{ positions: typeof positions; boxes: LaneBox[] }>({ positions, boxes });
  placedRef.current = { positions, boxes };

  useEffect(() => {
    const ancestors = ancestorMap(draft.nodes);
    setRfNodes([
      ...boxes.map(
        (l): Node<LaneData> => ({
          id: `lane:${l.id}`,
          type: "lane",
          position: { x: 0, y: l.y },
          measured: { width: canvasWidth, height: l.height },
          data: { color: l.color, width: canvasWidth, height: l.height },
          zIndex: -1,
          selectable: false,
          draggable: false,
          focusable: false,
        }),
      ),
      ...draft.nodes.map((n): Node<EditorNodeData> => {
        const info = nodeTypes.find((t) => t.type === n.type);
        const warnings = [
          ...(info?.prompt && prompts[n.id] && !prompts[n.id]?.text.trim() ? ["no prompt yet"] : []),
          ...(info?.needs ?? []).filter((need) => !ancestors.get(n.id)?.has(need)).map((need) => `run after ${need}`),
        ];
        return {
          id: n.id,
          type: "step",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          measured: { width: NODE_W, height: NODE_H },
          draggable: editable,
          data: { node: n, ...(info ? { info } : {}), color: nodeColor(lanes, n), selected: selection?.kind === "node" && selection.id === n.id, warnings, editable },
        };
      }),
    ]);
  }, [draft.nodes, boxes, positions, canvasWidth, lanes, nodeTypes, prompts, selection, editable]);

  // The drawer opens over the right of the canvas: bring the selected step out from under it.
  const selectedId = selection?.kind === "node" ? selection.id : undefined;
  useEffect(() => {
    const rect = sectionRef.current?.getBoundingClientRect();
    const at = selectedId ? positions.get(selectedId) : undefined;
    if (!rect || !at) return;
    const drawer = Math.min(DRAWER_MAX, rect.width * 0.48);
    const zoom = getZoom();
    const screen = flowToScreenPosition({ x: at.x + NODE_W, y: at.y });
    if (screen.x <= rect.right - drawer - 16 && screen.x - NODE_W * zoom >= rect.left) return;
    void setCenter(at.x + NODE_W / 2 + drawer / 2 / zoom, at.y + NODE_H / 2, { zoom, duration: 300 });
  }, [selectedId]);

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const on = selection?.kind === "edge" && selection.id === e.id;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          interactionWidth: 24,
          style: { stroke: on ? EDGE_SELECTED : EDGE_COLOR, strokeWidth: on ? 3 : 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: on ? EDGE_SELECTED : EDGE_COLOR, width: 14, height: 14 },
        };
      }),
    [graph.edges, selection],
  );

  /** The lane box at a canvas height (the nearest one outside every lane). */
  const boxAt = (y: number): LaneBox | undefined =>
    boxes.find((b) => y >= b.y && y <= b.y + b.height) ?? [...boxes].sort((a, b) => Math.abs(a.y + a.height / 2 - y) - Math.abs(b.y + b.height / 2 - y))[0];

  /** Places a step with its top-left corner at `topLeft`, in the lane under its centre. */
  function place(d: Draft, id: string, topLeft: { x: number; y: number }): Draft {
    const box = boxAt(topLeft.y + NODE_H / 2);
    const lane = lanes.find((l) => l.id === box?.id);
    if (!box || !lane) return d;
    // Every step keeps where it is now, so moving one never makes the others jump.
    const frozen = freeze(d, placedRef.current.positions, placedRef.current.boxes, lanes);
    const position = { x: snap(Math.max(LANE_LABEL_W, topLeft.x)), y: snap(Math.max(0, topLeft.y - box.y - LANE_PAD_Y)) };
    // Never drop a step onto another: slide right to the first free spot.
    const others = [...placedRef.current.positions].filter(([other]) => other !== id).map(([, p]) => p);
    const top = box.y + LANE_PAD_Y + position.y;
    for (let i = 0; i < 50 && others.some((p) => Math.abs(p.x - position.x) < NODE_W && Math.abs(p.y - top) < NODE_H); i++) position.x += NODE_W / 2;
    return { ...frozen, nodes: frozen.nodes.map((n) => (n.id === id ? { ...moveToLane(n, lane), position } : n)) };
  }

  function onDrop(e: DragEvent) {
    const type = e.dataTransfer.getData(STEP_MIME);
    if (!type || !editable) return;
    e.preventDefault();
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const next = addNode(draft, type, nodeTypes, lanes[0]);
    const added = next.nodes.length > draft.nodes.length ? next.nodes[next.nodes.length - 1]?.id : undefined;
    if (!added) return;
    const placed = place(next, added, { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 });
    onChange(() => placed);
    onSelect({ kind: "node", id: added }, nodeTypes.find((t) => t.type === type)?.prompt ? "prompt" : "settings");
  }

  function onKey(e: KeyboardEvent) {
    if (!editable || (e.key !== "Delete" && e.key !== "Backspace")) return;
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    if (selection?.kind === "edge") {
      const [source, target] = selection.id.split("->");
      if (source && target) onChange((d) => removeDependency(d, source, target));
      onSelect(undefined);
    } else if (selection?.kind === "node") onRemoveNode();
  }

  return (
    <section
      ref={sectionRef}
      className="ff-wf-canvas"
      aria-label="Workflow canvas"
      tabIndex={-1}
      onKeyDown={onKey}
      onDragOver={(e) => editable && e.dataTransfer.types.includes(STEP_MIME) && e.preventDefault()}
      onDrop={onDrop}
    >
      {editable ? (
        <Toolbar
          nodeTypes={nodeTypes}
          draft={draft}
          onAdd={(type) => {
            // Click to add: at the end of the selected step's lane (else the first lane), then shown.
            const selected = selection?.kind === "node" ? draft.nodes.find((n) => n.id === selection.id) : undefined;
            const lane = (selected && laneFor(lanes, selected)) ?? lanes[0];
            const box = boxes.find((b) => b.id === lane?.id);
            const next = addNode(draft, type, nodeTypes, lane);
            const added = next.nodes.length > draft.nodes.length ? next.nodes[next.nodes.length - 1]?.id : undefined;
            if (!added || !box || !lane) return;
            const inLane = draft.nodes.filter((n) => laneFor(lanes, n)?.id === lane.id).map((n) => positions.get(n.id)?.x ?? 0);
            const at = { x: inLane.length ? Math.max(...inLane) + NODE_W + 100 : LANE_LABEL_W, y: box.y + LANE_PAD_Y };
            onChange(() => place(next, added, at));
            onSelect({ kind: "node", id: added }, nodeTypes.find((t) => t.type === type)?.prompt ? "prompt" : "settings");
          }}
          onArrange={() => onChange((d) => ({ ...d, nodes: d.nodes.map(({ position: _p, ...n }) => n as WorkflowNodeDto) }))}
          onAddLane={() => onChange((d) => ({ ...d, lanes: [...d.lanes, { id: freeId(new Set(d.lanes.map((l) => l.id)), "lane"), title: `Lane ${d.lanes.length + 1}` }] }))}
        />
      ) : null}
      <ReactFlow
        colorMode={colorMode}
        nodes={rfNodes}
        edges={edges}
        nodeTypes={editorNodeTypes}
        onNodesChange={(changes: NodeChange<Node<EditorNodeData | LaneData>>[]) => setRfNodes((ns) => applyNodeChanges(changes, ns))}
        onNodeDragStop={(_, node) => onChange((d) => place(d, node.id, node.position))}
        onNodeClick={(_, n) => (n.type === "step" ? onSelect({ kind: "node", id: n.id }) : undefined)}
        onNodeDoubleClick={(_, n) => (n.type === "step" ? onSelect({ kind: "node", id: n.id }, "prompt") : undefined)}
        onEdgeClick={(_, e) => onSelect({ kind: "edge", id: e.id })}
        onPaneClick={() => onSelect(undefined)}
        onConnect={(c: Connection) => onChange((d) => addDependency(d, c.source, c.target))}
        isValidConnection={(c) => canDepend(draft.nodes, c.source, c.target)}
        connectionRadius={48}
        zoomOnDoubleClick={false}
        nodesConnectable={editable}
        nodesDraggable={editable}
        deleteKeyCode={null}
        snapToGrid
        snapGrid={[GRID, GRID]}
        fitView
        fitViewOptions={EDITOR_FIT}
        minZoom={0.3}
        maxZoom={1.5}
        panOnScroll
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.06, minZoom: 0.3, maxZoom: 1 }} />
        <LaneHeaders lanes={boxes} />
      </ReactFlow>
      {selection?.kind === "edge" && editable ? (
        <div className="ff-wf-edge-bar" role="status">
          <span>
            <strong>{draft.nodes.find((n) => n.id === selection.id.split("->")[1])?.label}</strong> runs after{" "}
            <strong>{draft.nodes.find((n) => n.id === selection.id.split("->")[0])?.label}</strong>
          </span>
          <button
            type="button"
            className="ff-btn ff-btn-small ff-btn-danger"
            onClick={() => {
              const [source, target] = selection.id.split("->");
              if (source && target) onChange((d) => removeDependency(d, source, target));
              onSelect(undefined);
            }}
          >
            Remove link
          </button>
        </div>
      ) : null}
      <p className="ff-wf-hint ff-muted ff-small">
        {editable
          ? "Drag a step onto a lane · drag steps anywhere · pull a step's right dot onto another step to make it wait · click a link or step and press Delete · scroll to pan, Ctrl+scroll to zoom"
          : "Click a step to edit its prompt or skills · scroll to pan, Ctrl+scroll to zoom"}
      </p>
    </section>
  );
}

/** Step types to drag onto the canvas (or click to add). Built-in steps appear once. */
function Toolbar({ nodeTypes, draft, onAdd, onArrange, onAddLane }: { nodeTypes: NodeTypeDto[]; draft: Draft; onAdd(type: string): void; onArrange(): void; onAddLane(): void }) {
  const used = new Set(draft.nodes.map((n) => n.id));
  const builtin = nodeTypes.filter((t) => t.fixedId);
  const available = builtin.filter((t) => !used.has(t.fixedId ?? ""));
  const chip = (t: NodeTypeDto) => (
    <button
      key={t.type}
      type="button"
      className="ff-wf-chip"
      draggable
      title={`${t.description} Drag onto a lane, or click to add.`}
      onDragStart={(e) => {
        e.dataTransfer.setData(STEP_MIME, t.type);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAdd(t.type)}
    >
      <span aria-hidden="true">{stepLook(t.type).icon}</span> {t.label}
    </button>
  );
  return (
    <div className="ff-wf-toolbar" role="toolbar" aria-label="Add steps">
      {nodeTypes.filter((t) => !t.fixedId).map(chip)}
      {available.length ? (
        <select className="ff-input ff-wf-builtin" value="" aria-label="Add a built-in step" onChange={(e) => e.target.value && onAdd(e.target.value)}>
          <option value="">+ Built-in step…</option>
          {available.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      ) : null}
      <span className="ff-wf-toolbar-sep" aria-hidden="true" />
      <button type="button" className="ff-btn ff-btn-small" onClick={onAddLane} disabled={draft.lanes.length >= 20}>
        + Lane
      </button>
      <button type="button" className="ff-btn ff-btn-small" onClick={onArrange} title="Lay every step out again in columns, following the links">
        Auto-arrange
      </button>
    </div>
  );
}

const EditorStep = memo(function EditorStep({ data }: NodeProps<Node<EditorNodeData>>) {
  const look = stepLook(data.node.type);
  const inset = (NODE_W - 60) / 2;
  return (
    <div
      className={`ff-gnode ff-wf-node${data.selected ? " ff-gnode-selected" : ""}${data.warnings.length ? " ff-wf-node-warn" : ""}`}
      style={{ width: NODE_W, height: NODE_H, "--lane": data.color } as CSSProperties}
      title={[data.node.label, data.info?.label, ...data.warnings].filter(Boolean).join(" · ")}
    >
      <Handle type="target" position={Position.Left} isConnectable={data.editable} style={{ top: 30, left: inset }} />
      <div className="ff-gnode-card" style={{ width: 60, height: 60 }}>
        <span className="ff-gnode-icon" aria-hidden="true">
          {look.icon}
        </span>
        {data.warnings.length ? (
          <span className="ff-gnode-status ff-wf-node-badge" aria-label={data.warnings.join(", ")}>
            ⚠
          </span>
        ) : null}
        <span className="ff-gnode-chips">{data.info?.kind === "ai" ? <span className="ff-gnode-chip ff-gnode-chip-ai">AI</span> : null}</span>
      </div>
      <div className="ff-gnode-title">{data.node.label || "Untitled step"}</div>
      <div className="ff-gnode-note">{data.warnings[0] ?? (look.does || data.info?.label)}</div>
      <Handle type="source" position={Position.Right} isConnectable={data.editable} style={{ top: 30, right: inset }} />
    </div>
  );
});

const editorNodeTypes = { step: EditorStep, lane: LaneNode };

function DrawerHead({ title, onClose, children }: { title: string; onClose(): void; children?: ReactNode }) {
  return (
    <div className="ff-wf-drawer-head">
      {children}
      <h2 className="ff-grow">{title}</h2>
      <button type="button" className="ff-btn ff-btn-small" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
  );
}

function NodeDrawer({
  workflowId,
  node,
  draft,
  tab,
  info,
  prompt,
  saved,
  editable,
  onTab,
  onChange,
  onPrompt,
  onRemove,
  onClose,
}: {
  workflowId: string;
  node: WorkflowNodeDto;
  draft: Draft;
  tab: NodeTab;
  info: NodeTypeDto | undefined;
  prompt: PromptState | undefined;
  /** The step exists in the saved workflow (skills attach to saved steps only). */
  saved: boolean;
  editable: boolean;
  onTab(tab: NodeTab): void;
  onChange(fn: (d: Draft) => Draft): void;
  onPrompt(text: string): void;
  onRemove(): void;
  onClose(): void;
}) {
  const tabs: NodeTab[] = ["settings", ...(info?.prompt ? (["prompt"] as const) : []), ...(info?.kind === "ai" ? (["skills"] as const) : [])];
  const current = tabs.includes(tab) ? tab : "settings";
  return (
    <>
      <DrawerHead title={node.label || "Untitled step"} onClose={onClose}>
        <span aria-hidden="true">{stepLook(node.type).icon}</span>
      </DrawerHead>
      <p className="ff-muted ff-small ff-wf-drawer-sub">
        {info?.label ?? node.type} · <span className="ff-mono">{node.id}</span>
      </p>
      <div className="ff-tabs ff-tabs-small" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={current === t} className={`ff-tab${current === t ? " ff-tab-active" : ""}`} onClick={() => onTab(t)}>
            {t === "settings" ? "Settings" : t === "prompt" ? `Prompt${prompt && !prompt.text.trim() ? " ⚠" : prompt && prompt.text !== prompt.saved.text ? " •" : ""}` : "Skills"}
          </button>
        ))}
      </div>
      <div className="ff-wf-drawer-body">
        {current === "settings" ? (
          <NodeSettings node={node} draft={draft} info={info} editable={editable} onChange={onChange} onRemove={onRemove} />
        ) : current === "prompt" ? (
          <StepPrompt nodeType={node.type} prompt={prompt} onChange={onPrompt} />
        ) : (
          <NodeSkills workflowId={workflowId} nodeId={node.id} saved={saved} />
        )}
      </div>
    </>
  );
}

function NodeSettings({
  node,
  draft,
  info,
  editable,
  onChange,
  onRemove,
}: {
  node: WorkflowNodeDto;
  draft: Draft;
  info: NodeTypeDto | undefined;
  editable: boolean;
  onChange(fn: (d: Draft) => Draft): void;
  onRemove(): void;
}) {
  const lanes = lanesOf(draft.lanes, draft.nodes);
  const setNode = (patch: Partial<WorkflowNodeDto>) => onChange((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) }));
  const candidates = draft.nodes.filter((n) => n.id !== node.id && !node.dependencies.includes(n.id) && canDepend(draft.nodes, n.id, node.id));
  const label = (id: string) => draft.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="ff-wf-panel">
      {info?.description ? <p className="ff-muted ff-small">{info.description}</p> : null}
      <label className="ff-field">
        <span>Name</span>
        <input className="ff-input" value={node.label} maxLength={120} disabled={!editable} onChange={(e) => setNode({ label: e.target.value })} />
      </label>
      <label className="ff-field">
        <span>Description</span>
        <textarea
          className="ff-input"
          rows={2}
          maxLength={1000}
          value={node.description ?? ""}
          disabled={!editable}
          onChange={(e) => setNode(e.target.value ? { description: e.target.value } : { description: undefined })}
        />
      </label>
      <label className="ff-field">
        <span>Lane</span>
        <select
          className="ff-input"
          value={laneFor(lanes, node)?.id ?? ""}
          disabled={!editable}
          onChange={(e) => {
            const lane = lanes.find((l) => l.id === e.target.value);
            // A step moved by the menu is laid out again in its new lane.
            if (lane) onChange((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? withoutPosition(moveToLane(n, lane)) : n)) }));
          }}
        >
          {lanes.map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}
            </option>
          ))}
        </select>
      </label>
      <div className="ff-field">
        <span>Runs after</span>
        {node.dependencies.length ? (
          <ul className="ff-wf-deps">
            {node.dependencies.map((dep) => (
              <li key={dep}>
                <span className="ff-grow">{label(dep)}</span>
                {editable ? (
                  <button type="button" className="ff-btn ff-btn-small" aria-label={`Stop waiting for ${label(dep)}`} onClick={() => onChange((d) => removeDependency(d, dep, node.id))}>
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <small className="ff-muted">Starts as soon as the feature starts.</small>
        )}
        {editable && candidates.length ? (
          <select className="ff-input" value="" aria-label="Add a step to run after" onChange={(e) => e.target.value && onChange((d) => addDependency(d, e.target.value, node.id))}>
            <option value="">+ Run after…</option>
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        ) : null}
        {info?.needs?.length ? <small className="ff-muted">Reads the output of {info.needs.map(label).join(", ")}: they must run before it.</small> : null}
      </div>
      {editable ? (
        <div className="ff-actions">
          <button type="button" className="ff-btn ff-btn-danger" onClick={onRemove}>
            Remove step
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The step's prompt, edited in the editor and saved with the workflow. */
function StepPrompt({ nodeType, prompt, onChange }: { nodeType: string; prompt: PromptState | undefined; onChange(text: string): void }) {
  const navigate = useApp((s) => s.navigate);
  if (!prompt) return <Loading label="Loading prompt" />;
  const placeholders = GENERIC_PLACEHOLDERS[nodeType] ?? prompt.saved.placeholders;
  return (
    <div className="ff-wf-panel ff-wf-prompt">
      <p className="ff-muted ff-small">
        {nodeType === "manual.check"
          ? "The checklist shown to the person checking this step while it waits."
          : "What Claude is asked to do in this step, in every project. It applies the next time the step runs."}{" "}
        Saved with the workflow (Save).
      </p>
      <textarea
        className="ff-input ff-mono ff-wf-prompt-text"
        aria-label="Prompt"
        value={prompt.text}
        spellCheck={false}
        placeholder="Write what this step should do. A feature cannot start this workflow while a step has no prompt."
        onChange={(e) => onChange(e.target.value)}
      />
      {placeholders.length ? (
        <p className="ff-small ff-muted">
          Filled in when the step runs:{" "}
          {placeholders.map((p) => (
            <button key={p} type="button" className="ff-prompt-var" title="Add at the end" onClick={() => onChange(`${prompt.text}${prompt.text && !prompt.text.endsWith("\n") ? " " : ""}{{${p}}}`)}>
              {`{{${p}}}`}
            </button>
          ))}
        </p>
      ) : null}
      <div className="ff-actions">
        {prompt.text !== prompt.saved.text ? (
          <button type="button" className="ff-btn ff-btn-small" onClick={() => onChange(prompt.saved.text)}>
            Undo changes
          </button>
        ) : null}
        {prompt.saved.defaultText && prompt.text !== prompt.saved.defaultText ? (
          <button type="button" className="ff-btn ff-btn-small" onClick={() => onChange(prompt.saved.defaultText)}>
            Use the default
          </button>
        ) : null}
        <span className="ff-grow" />
        <button type="button" className="ff-link ff-small" onClick={() => navigate({ name: "prompts" })}>
          System prompt &amp; project additions →
        </button>
      </div>
    </div>
  );
}

/** Skills of a saved AI step, attached the same way as on the Skills screen (applied at once). */
function NodeSkills({ workflowId, nodeId, saved }: { workflowId: string; nodeId: string; saved: boolean }) {
  const notify = useApp((s) => s.notify);
  const navigate = useApp((s) => s.navigate);
  const [state, setState] = useState<SkillsStateDto>();
  const step = `${workflowId}/${nodeId}`;
  useEffect(() => {
    void api.invoke("skills:list").then(setState, () => setState(undefined));
  }, [step]);
  if (!saved) return <p className="ff-muted">Save the workflow first to attach skills to this new step.</p>;
  if (!state) return <Loading label="Loading skills" />;
  const names = state.assignments[step] ?? [];
  const available = state.skills.filter((s) => !names.includes(s.name));
  async function assign(next: string[]) {
    try {
      const assignments = await api.invoke("skills:assign", { workflowId, nodeId, skills: next });
      setState((s) => (s ? { ...s, assignments } : s));
    } catch (err) {
      notify("error", errorMessage(err));
    }
  }
  return (
    <div className="ff-wf-panel">
      <p className="ff-muted ff-small">Instructions added to this step&apos;s prompt when it runs. Changes apply at once.</p>
      {names.length ? (
        <ul className="ff-wf-deps">
          {names.map((name) => (
            <li key={name}>
              <span className="ff-grow ff-mono">{name}</span>
              <button type="button" className="ff-btn ff-btn-small" aria-label={`Remove ${name}`} onClick={() => void assign(names.filter((n) => n !== name))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ff-muted">No skills.</p>
      )}
      {available.length ? (
        <select className="ff-input" value="" aria-label="Add a skill" onChange={(e) => e.target.value && void assign([...names, e.target.value])}>
          <option value="">+ Add skill…</option>
          {available.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} — {s.description}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className="ff-link ff-small" onClick={() => navigate({ name: "skills", step })}>
        Skills library →
      </button>
    </div>
  );
}

/** Name, description and lanes of the workflow. */
function WorkflowDrawer({ draft, editable, onChange, onClose }: { draft: Draft; editable: boolean; onChange(fn: (d: Draft) => Draft): void; onClose(): void }) {
  const [removing, setRemoving] = useState<string>();
  const lanes = lanesOf(draft.lanes, draft.nodes);
  const setLane = (id: string, patch: Partial<LaneDto>) => onChange((d) => ({ ...d, lanes: d.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const moveLane = (i: number, by: -1 | 1) =>
    onChange((d) => {
      const next = [...d.lanes];
      const [lane] = next.splice(i, 1);
      if (lane) next.splice(i + by, 0, lane);
      return { ...d, lanes: next };
    });
  return (
    <>
      <DrawerHead title="Workflow & lanes" onClose={onClose} />
      <div className="ff-wf-drawer-body ff-wf-panel">
        <label className="ff-field">
          <span>Name</span>
          <input className="ff-input" value={draft.name} maxLength={120} disabled={!editable} onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))} />
        </label>
        <label className="ff-field">
          <span>Description</span>
          <textarea className="ff-input" rows={3} maxLength={2000} value={draft.description} disabled={!editable} onChange={(e) => onChange((d) => ({ ...d, description: e.target.value }))} />
        </label>
        <h3>Lanes</h3>
        <p className="ff-muted ff-small">The rows of the canvas, top to bottom: one per stage of the work.</p>
        <ol className="ff-wf-lanes">
          {draft.lanes.map((lane, i) => {
            const count = draft.nodes.filter((n) => laneFor(lanes, n)?.id === lane.id).length;
            return (
              <li key={lane.id}>
                <span className="ff-lane-dot" style={{ background: lanes.find((l) => l.id === lane.id)?.color }} />
                <div className="ff-grow ff-wf-lane-fields">
                  <input className="ff-input" value={lane.title} maxLength={120} disabled={!editable} aria-label={`Title of lane ${i + 1}`} onChange={(e) => setLane(lane.id, { title: e.target.value })} />
                  <input
                    className="ff-input ff-small"
                    value={lane.subtitle ?? ""}
                    placeholder="Subtitle (optional)"
                    maxLength={300}
                    disabled={!editable}
                    aria-label={`Subtitle of lane ${i + 1}`}
                    onChange={(e) => setLane(lane.id, e.target.value ? { subtitle: e.target.value } : { subtitle: undefined })}
                  />
                  <small className="ff-muted">{count === 1 ? "1 step" : `${count} steps`}</small>
                </div>
                {editable ? (
                  <div className="ff-wf-lane-actions">
                    <button type="button" className="ff-btn ff-btn-small" disabled={i === 0} onClick={() => moveLane(i, -1)} aria-label={`Move ${lane.title} up`}>
                      ↑
                    </button>
                    <button type="button" className="ff-btn ff-btn-small" disabled={i === draft.lanes.length - 1} onClick={() => moveLane(i, 1)} aria-label={`Move ${lane.title} down`}>
                      ↓
                    </button>
                    <button
                      type="button"
                      className="ff-btn ff-btn-small ff-btn-danger"
                      disabled={count > 0 || draft.lanes.length === 1}
                      title={count > 0 ? "Move its steps to another lane first" : undefined}
                      onClick={() => setRemoving(lane.id)}
                      aria-label={`Remove ${lane.title}`}
                    >
                      ×
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      <ConfirmDialog
        open={removing !== undefined}
        title="Remove this lane?"
        confirmLabel="Remove lane"
        danger
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          onChange((d) => ({ ...d, lanes: d.lanes.filter((l) => l.id !== removing) }));
          setRemoving(undefined);
        }}
      >
        <p>The empty lane is removed from the workflow when you save it.</p>
      </ConfirmDialog>
    </>
  );
}

function ProblemsDrawer({
  problems,
  serverIssues,
  label,
  onOpen,
  onClose,
}: {
  problems: Problem[];
  serverIssues: string[];
  label(id: string): string;
  onOpen(p: Problem): void;
  onClose(): void;
}) {
  return (
    <>
      <DrawerHead title="Problems" onClose={onClose} />
      <div className="ff-wf-drawer-body ff-wf-panel">
        {problems.length || serverIssues.length ? (
          <ul className="ff-wf-problems">
            {problems.map((p, i) => (
              <li key={`${p.nodeId}-${i}`}>
                <button type="button" className="ff-wf-problem" onClick={() => onOpen(p)}>
                  <span aria-hidden="true">⚠</span>
                  <span>
                    <strong>{p.nodeId ? label(p.nodeId) : "Workflow"}</strong> {p.text}
                  </span>
                </button>
              </li>
            ))}
            {serverIssues.map((issue) => (
              <li key={issue} className="ff-wf-problem">
                <span aria-hidden="true">✕</span>
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ff-muted">✓ Every step has what it needs.</p>
        )}
      </div>
    </>
  );
}

// --- Draft operations (pure) ---

function toGraph(draft: Draft): { nodes: GraphNodeDto[]; edges: GraphEdgeDto[] } {
  return {
    nodes: draft.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      ...(n.group ? { group: n.group } : {}),
      ...(n["position"] ? { position: n["position"] as { x: number; y: number } } : {}),
    })),
    edges: draft.nodes.flatMap((n) => n.dependencies.map((dep) => ({ id: `${dep}->${n.id}`, source: dep, target: n.id, conditional: false }))),
  };
}

/** Stores every step's current spot (relative to its lane), so placing one never moves the others. */
function freeze(draft: Draft, positions: Map<string, { x: number; y: number }>, boxes: LaneBox[], lanes: Lane[]): Draft {
  return {
    ...draft,
    nodes: draft.nodes.map((n) => {
      if (n["position"]) return n;
      const at = positions.get(n.id);
      const box = boxes.find((b) => b.id === laneFor(lanes, n)?.id);
      return at && box ? { ...n, position: { x: snap(at.x), y: snap(Math.max(0, at.y - box.y - LANE_PAD_Y)) } } : n;
    }),
  };
}

function withoutPosition(node: WorkflowNodeDto): WorkflowNodeDto {
  const { position: _p, ...rest } = node;
  return rest as WorkflowNodeDto;
}

function freeId(taken: Set<string>, prefix: string): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function addNode(draft: Draft, type: string, nodeTypes: NodeTypeDto[], lane: Lane | undefined): Draft {
  const info = nodeTypes.find((t) => t.type === type);
  if (!info || !lane) return draft;
  const taken = new Set(draft.nodes.map((n) => n.id));
  if (info.fixedId && taken.has(info.fixedId)) return draft;
  const id = info.fixedId ?? freeId(taken, type === "manual.check" ? "check" : "prompt");
  const node: WorkflowNodeDto = { ...structuredClone(info.template), id, group: lane.groups[0] ?? lane.id, dependencies: [] };
  return { ...draft, nodes: [...draft.nodes, node] };
}

function removeNode(draft: Draft, id: string): Draft {
  return { ...draft, nodes: draft.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, dependencies: n.dependencies.filter((d) => d !== id) })) };
}

/** A step already in one of the lane's groups keeps it (the built-in lane ④ holds C1 and C2). */
function moveToLane(node: WorkflowNodeDto, lane: Lane): WorkflowNodeDto {
  return lane.groups.includes(node.group ?? "") ? node : { ...node, group: lane.groups[0] ?? lane.id };
}

function addDependency(draft: Draft, source: string | null, target: string | null): Draft {
  if (!source || !target || !canDepend(draft.nodes, source, target)) return draft;
  return { ...draft, nodes: draft.nodes.map((n) => (n.id === target && !n.dependencies.includes(source) ? { ...n, dependencies: [...n.dependencies, source] } : n)) };
}

function removeDependency(draft: Draft, source: string, target: string): Draft {
  return {
    ...draft,
    nodes: draft.nodes.map((n) => {
      if (n.id !== target) return n;
      const next: WorkflowNodeDto = { ...n, dependencies: n.dependencies.filter((d) => d !== source) };
      // A branch condition or an "any" join on the removed link would no longer be valid.
      if ((next["when"] as { node?: string } | undefined)?.node === source) delete next["when"];
      if (next.dependencies.length < 2) delete next["joinMode"];
      return next;
    }),
  };
}

/** `target` may wait for `source`: not itself, not twice, and no cycle. */
function canDepend(nodes: WorkflowNodeDto[], source: string | null, target: string | null): boolean {
  if (!source || !target || source === target) return false;
  const t = nodes.find((n) => n.id === target);
  if (!t || t.dependencies.includes(source)) return false;
  return !ancestorMap(nodes).get(source)?.has(target);
}

function ancestorMap(nodes: WorkflowNodeDto[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, Set<string>>();
  const visit = (id: string, seen: Set<string>): Set<string> => {
    const known = out.get(id);
    if (known) return known;
    const result = new Set<string>();
    if (seen.has(id)) return result;
    seen.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      result.add(dep);
      for (const a of visit(dep, seen)) result.add(a);
    }
    out.set(id, result);
    return result;
  };
  for (const n of nodes) visit(n.id, new Set());
  return out;
}
