import { createContext, memo, useContext, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Background,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import type { NodeRun } from "@frontflow/domain";
import { visualStateForNode } from "@frontflow/ui-components";
import type { GraphNodeDto, RunStateDto } from "../../../shared/ipc.js";
import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";
import { formatDuration, formatTime, stepDuration, type ActivityLine } from "../lib/activity.js";
import { lanesOf, laneFor, nodeColor, type Lane } from "../lib/groups.js";
import { stepLook } from "../lib/steps.js";
import { StepIcon } from "../components/StepIcon.js";
import { useTheme } from "../lib/theme.js";

/** n8n-style step: a square card with the icon, the name and one line underneath. */
const CARD = 60;
export const NODE_W = 168;
export const NODE_H = 124;
/** Wide enough between columns for the hand-off label of an edge and a decision's other way out. */
const COL_W = NODE_W + 100;
const ROW_H = NODE_H + 8;
/** Swimlane geometry: the lane title sits in a strip on the left, steps start right of it. */
export const LANE_LABEL_W = 150;
const LANE_PAD_X = 16;
export const LANE_PAD_Y = 12;
/** Room between stages for the arrows that hand over from one stage to the next. */
const LANE_GAP = 26;
/** The canvas always shows the whole workflow (fit to the window); the controls still zoom in. */
export const FIT = { padding: 0.04, minZoom: 0.4, maxZoom: 1 } as const;
/** Below this the step names are too small to read: the canvas pans instead of shrinking further. */
const READABLE_ZOOM = 0.75;
/** Following the live steps shows them at full size when the window allows, with this screen margin. */
const FOLLOW_ZOOM = 1;
const FOLLOW_PAD = 32;

// Edge colours are SVG attributes (arrow markers), so they are literal hex rather than CSS variables.
const EDGE = { done: "#4cb782", active: "#26b5ce", waiting: "#f2994a", failed: "#eb5757", idle: "#8a8f98" } as const;
type EdgeKind = keyof typeof EDGE;
const EDGE_ICON: Record<EdgeKind, string> = { done: "✓", active: "▶", waiting: "⏸", failed: "✕", idle: "" };
const EDGE_STATE: Record<EdgeKind, string> = { done: "delivered", active: "in progress", waiting: "waiting for your input", failed: "blocked", idle: "not yet" };

interface FlowEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  /** State of the source's output, for the output label: delivered once the source passed. */
  labelKind: EdgeKind;
  label?: string;
  /** Step labels at both ends, for the accessible title. */
  from: string;
  to: string;
  /** Another step is selected and this edge does not touch it. */
  faded: boolean;
}


export interface LaneData extends Record<string, unknown> {
  color: string;
  width: number;
  height: number;
}

interface FlowNodeData extends Record<string, unknown> {
  node: GraphNodeDto;
  color: string;
  nodeRun?: NodeRun;
  note?: string;
  duration?: number;
  selected: boolean;
}

const CanvasContext = createContext<{ runId: string; onSelect(id: string): void }>({ runId: "", onSelect: () => {} });

/**
 * n8n-style workflow canvas beside the run panel, with manual actions on every step. While the run
 * has live steps (`live`: waiting for the user, working, failed — most urgent first) the canvas
 * follows them, zoomed in with their neighbours; panning or zooming by hand stops following until
 * the user turns it back on. Without live steps it shows the whole workflow when that stays readable.
 */
export function GraphView({
  runId,
  graph,
  latest,
  lastByNode,
  selected,
  live,
  now,
  onSelect,
}: {
  runId: string;
  graph: RunStateDto["graph"];
  latest: Map<string, NodeRun>;
  lastByNode: Map<string, ActivityLine>;
  selected?: string | undefined;
  live: string[];
  now: number;
  onSelect(id: string): void;
}) {
  const { resolved: colorMode } = useTheme();
  const [follow, setFollow] = useState(true);
  const pause = () => setFollow(false);
  const workflowLanes = useMemo(() => lanesOf(graph.lanes, graph.nodes), [graph.lanes, graph.nodes]);
  const { positions, lanes, width: graphWidth } = useMemo(() => layout(graph, workflowLanes), [graph, workflowLanes]);
  const graphHeight = Math.max(0, ...lanes.map((l) => l.y + l.height));
  const labels = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.label])), [graph.nodes]);

  // Nodes are rebuilt every tick (`now`) without onNodesChange. A node object without `measured`
  // makes React Flow drop its size and handle bounds and hide it until re-measured; when a rebuild
  // lands right after a measurement the ResizeObserver never fires again and the canvas stays blank.
  // Every node has a fixed size, so it is given up front and the handle bounds survive rebuilds.
  const nodes: Node<FlowNodeData | LaneData>[] = useMemo(
    () => [
      // Swimlane bands sit behind the steps and take no clicks.
      ...lanes.map(
        (l): Node<LaneData> => ({
          id: `lane:${l.id}`,
          type: "lane",
          position: { x: 0, y: l.y },
          measured: { width: graphWidth, height: l.height },
          data: { color: l.color, width: graphWidth, height: l.height },
          zIndex: -1,
          selectable: false,
          draggable: false,
          focusable: false,
        }),
      ),
      ...graph.nodes.map((n): Node<FlowNodeData> => {
        const nr = latest.get(n.id);
        const duration = stepDuration(nr, now);
        const note = noteFor(nr, lastByNode.get(n.id), labels);
        return {
          id: n.id,
          type: "step",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          measured: { width: NODE_W, height: NODE_H },
          data: {
            node: n,
            color: nodeColor(workflowLanes, n),
            selected: n.id === selected,
            ...(nr ? { nodeRun: nr } : {}),
            ...(note ? { note } : {}),
            ...(duration !== undefined ? { duration } : {}),
          },
        };
      }),
    ],
    [graph.nodes, workflowLanes, positions, lanes, graphWidth, latest, lastByNode, labels, selected, now],
  );

  const types = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.type])), [graph.nodes]);
  const edges: Edge<FlowEdgeData>[] = useMemo(() => {
    const labelled = new Set<string>();
    return graph.edges.map((e) => {
        const source = latest.get(e.source)?.status;
        const target = latest.get(e.target)?.status;
        const kind: EdgeKind =
          target === "failed" || target === "blocked"
            ? "failed"
            : target === "running" || target === "retrying"
              ? "active"
              : target === "waiting_for_input"
                ? "waiting"
                : source === "passed" || source === "skipped"
                  ? "done"
                  : "idle";
        // One output label per step, on its first edge, like n8n's item count next to an output.
        const label = labelled.has(e.source) ? undefined : stepLook(types.get(e.source) ?? "").handoff;
        labelled.add(e.source);
        const faded = !!selected && e.source !== selected && e.target !== selected;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "flow",
          animated: kind === "active",
          // Edges of the selected step and edges with something happening are drawn on top.
          zIndex: faded ? 0 : kind === "idle" || kind === "done" ? 1 : 2,
          data: { kind, labelKind: outputKind(source), faded, from: labels.get(e.source) ?? e.source, to: labels.get(e.target) ?? e.target, ...(label ? { label } : {}) },
          markerEnd: { type: MarkerType.ArrowClosed, color: EDGE[kind], width: 14, height: 14 },
        };
      });
  }, [graph.edges, latest, types, labels, selected]);

  return (
    <section className="ff-canvas" aria-label="Workflow canvas">
      <header className="ff-canvas-head">
        <h3>Workflow canvas</h3>
        <div className="ff-canvas-key" aria-label="How to read the canvas">
          <span>
            <i className="ff-key-input" aria-hidden="true" /> needs your input
          </span>
          <span>
            <i className="ff-key-ai" aria-hidden="true">
              AI
            </i>{" "}
            done by the AI CLI
          </span>
          <span>
            <i className="ff-key-decision" aria-hidden="true">
              ◆
            </i>{" "}
            decision
          </span>
        </div>
        <button
          type="button"
          className={`ff-btn ff-btn-small ff-canvas-follow${follow ? " ff-btn-active" : ""}`}
          aria-pressed={follow}
          title={follow ? "The canvas zooms to the step that is running or waiting for you. Pan or zoom to look around." : "Zoom back to the step that is running or waiting for you, and keep following it"}
          onClick={() => setFollow(!follow)}
        >
          {follow ? "◉ Following live step" : "◎ Follow live step"}
        </button>
      </header>
      <CanvasContext.Provider value={{ runId, onSelect }}>
        <div
          className="ff-graph"
          // The minimap moves the canvas without a pan event: dragging or scrolling it is looking around too.
          onPointerDownCapture={(e) => {
            if ((e.target as Element).closest(".react-flow__minimap")) pause();
          }}
          onWheelCapture={(e) => {
            if ((e.target as Element).closest(".react-flow__minimap")) pause();
          }}
        >
          <ReactFlow
            colorMode={colorMode}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, n) => {
              if (n.type === "step") onSelect(n.id);
            }}
            // Only the user's own moves carry an event; the canvas's moves to the live steps have none.
            onMoveStart={(event) => {
              if (event) pause();
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            // The canvas sits beside the panel: scroll pans it, Ctrl+scroll zooms; it fits the window when it can stay readable.
            panOnScroll
            zoomOnScroll={false}
            minZoom={0.15}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls position="bottom-right" showInteractive={false} fitViewOptions={FIT} onZoomIn={pause} onZoomOut={pause} onFitView={pause} />
            <LaneHeaders lanes={lanes} />
            <MiniMap
              className="ff-minimap"
              // Bottom-left would cover the sticky lane titles.
              position="bottom-right"
              pannable
              zoomable
              ariaLabel="Workflow overview"
              nodeColor={(n) => (n.type === "lane" ? "transparent" : EDGE[outputKind((n.data as FlowNodeData).nodeRun?.status)])}
              nodeStrokeWidth={0}
            />
            <AutoView
              layoutKey={`${graphWidth}x${lanes.length}:${graph.nodes.length}`}
              width={graphWidth}
              height={graphHeight}
              positions={positions}
              edges={graph.edges}
              live={live}
              selected={selected}
              follow={follow}
              onPause={pause}
            />
          </ReactFlow>
        </div>
      </CanvasContext.Provider>
    </section>
  );
}

/**
 * Moves the canvas for the user. Following: on open, on resize and whenever the live steps change it
 * zooms to them (with the steps right before and after, while that stays readable). Not following,
 * or with no live step: it fits the whole workflow if that is readable, else shows its start.
 * Opening a step out of view pans there; that step not being live stops following.
 */
function AutoView({
  layoutKey,
  width,
  height,
  positions,
  edges,
  live,
  selected,
  follow,
  onPause,
}: {
  layoutKey: string;
  width: number;
  height: number;
  positions: Map<string, { x: number; y: number }>;
  edges: RunStateDto["graph"]["edges"];
  live: string[];
  selected: string | undefined;
  follow: boolean;
  onPause(): void;
}) {
  const { fitView, setCenter, setViewport, getViewport } = useReactFlow();
  const w = useStore((s) => s.width);
  const h = useStore((s) => s.height);
  const liveKey = live.join(",");

  /** The view that fits these steps, clear of the lane titles pinned over the canvas's left edge. */
  function viewOf(ids: string[]): Viewport | undefined {
    const at = ids.flatMap((id) => positions.get(id) ?? []);
    if (!at.length) return undefined;
    const x0 = Math.min(...at.map((p) => p.x));
    const y0 = Math.min(...at.map((p) => p.y));
    const bw = Math.max(...at.map((p) => p.x)) + NODE_W - x0;
    const bh = Math.max(...at.map((p) => p.y)) + NODE_H - y0;
    const zoom = Math.max(FIT.minZoom, Math.min(FOLLOW_ZOOM, (w - 2 * FOLLOW_PAD) / (bw + LANE_LABEL_W), (h - 2 * FOLLOW_PAD) / bh));
    const left = LANE_LABEL_W * zoom;
    return { zoom, x: left + (w - left - bw * zoom) / 2 - x0 * zoom, y: (h - bh * zoom) / 2 - y0 * zoom };
  }

  function show(duration: number) {
    if (!w || !h) return;
    if (follow && live.length) {
      const around = [...live, ...edges.flatMap((e) => (live.includes(e.source) ? [e.target] : live.includes(e.target) ? [e.source] : []))];
      // Fewer steps until it stays readable: the live ones with their neighbours, the live ones, the most urgent one.
      const views = [around, live, live.slice(0, 1)].flatMap((ids) => viewOf(ids) ?? []);
      const view = views.find((v) => v.zoom >= READABLE_ZOOM) ?? views.at(-1);
      if (view) return void setViewport(view, { duration });
    }
    if (Math.min(w / width, h / height) * 0.96 >= READABLE_ZOOM) return void fitView({ ...FIT, duration });
    // Too big to read whole: start where the workflow starts (its top-left corner).
    void setCenter(w / 2 / READABLE_ZOOM, h / 2 / READABLE_ZOOM, { zoom: READABLE_ZOOM, duration });
  }

  useEffect(() => show(0), [w, h, layoutKey]);
  // Stopping following leaves the canvas where the user took it.
  useEffect(() => {
    if (follow) show(matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400);
  }, [liveKey, follow]);

  useEffect(() => {
    const at = selected ? positions.get(selected) : undefined;
    if (!selected || !at || !w || !h) return;
    const { x, y, zoom } = getViewport();
    const left = at.x * zoom + x;
    const top = at.y * zoom + y;
    if (left >= 0 && top >= 0 && left + NODE_W * zoom <= w && top + NODE_H * zoom <= h) return;
    if (!live.includes(selected)) onPause();
    void setCenter(at.x + NODE_W / 2, at.y + NODE_H / 2, { zoom: Math.max(zoom, READABLE_ZOOM), duration: 300 });
  }, [selected]);
  return null;
}

interface NodeAction {
  label: string;
  primary?: boolean;
  run(): Promise<unknown> | void;
  done?: string;
}

const StepNode = memo(function StepNode({ id, data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, onSelect } = useContext(CanvasContext);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const nr = data.nodeRun;
  const spec = visualStateForNode(nr?.status);
  const action = actionFor(data.node, nr, runId, () => onSelect(id));

  async function perform(a: NodeAction) {
    setBusy(true);
    try {
      await a.run();
      if (a.done) notify("info", a.done);
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const look = stepLook(data.node.type);
  const status = nr?.status;
  const running = status === "running" || status === "retrying";
  // The other way out of a decision is "taken" when the step stopped on it.
  const otherwiseTaken = status === "waiting_for_input" || status === "blocked" || status === "failed";
  const tooltip = [
    data.node.label,
    look.does,
    spec.label,
    data.note,
    data.duration !== undefined ? `took ${formatDuration(data.duration)}` : "",
    nr?.assumed ? "result is assumed" : "",
    nr && nr.attempt > 1 ? `attempt ${nr.attempt}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const handleY = { top: CARD / 2 };
  const inset = (NODE_W - CARD) / 2;

  return (
    <div
      className={`ff-gnode ff-gnode-${spec.tone}${running ? " ff-gnode-live" : ""}${data.selected ? " ff-gnode-selected" : ""}${look.input ? " ff-gnode-input" : ""}`}
      style={{ width: NODE_W, height: NODE_H, "--lane": data.color } as CSSProperties}
      title={tooltip}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ ...handleY, left: inset }} />
      <div className="ff-gnode-card" style={{ width: CARD, height: CARD }}>
        <span className="ff-gnode-icon" aria-hidden="true">
          <StepIcon name={look.icon} />
        </span>
        <span className={`ff-gnode-status${spec.animated ? " ff-spin" : ""}`} aria-label={spec.label}>
          {spec.icon}
        </span>
        {look.input ? <span className="ff-gnode-you">you</span> : null}
        <span className="ff-gnode-chips">
          {data.node.ai ? <span className="ff-gnode-chip ff-gnode-chip-ai">AI</span> : null}
          {nr?.assumed ? <span className="ff-gnode-chip ff-gnode-chip-assumed" title="assumed">≈</span> : null}
          {nr && nr.attempt > 1 ? <span className="ff-gnode-chip">×{nr.attempt}</span> : null}
          {data.duration !== undefined && nr?.startedAt ? (
            <span
              className="ff-gnode-chip ff-gnode-chip-time"
              title={`Started ${formatTime(nr.startedAt)}${nr.finishedAt ? ` · finished ${formatTime(nr.finishedAt)}` : " · still running"}`}
            >
              ⏱ {formatDuration(data.duration)}
            </span>
          ) : null}
        </span>
      </div>
      {look.decision ? (
        <span className="ff-gnode-pass" style={{ left: inset + CARD + 8, top: CARD / 2 - 27 }}>
          ✓ {look.decision.pass}
        </span>
      ) : null}
      {look.decision ? (
        <div className={`ff-gnode-branch${otherwiseTaken ? " ff-gnode-branch-taken" : ""}`} style={{ left: inset + CARD }}>
          <span className="ff-gnode-branch-line" aria-hidden="true" />
          <span className="ff-gnode-branch-label">
            <b aria-hidden="true">◆</b> {look.decision.otherwise}
            {look.decision.loop ? " ↺" : ""}
          </span>
        </div>
      ) : null}
      <div className="ff-gnode-title">{data.node.label}</div>
      {action?.primary ? (
        <button
          type="button"
          className="ff-gnode-action ff-gnode-action-primary nodrag nopan"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void perform(action);
          }}
        >
          {action.label}
        </button>
      ) : (
        <div className="ff-gnode-note">{running ? (data.note ?? "Working…") : look.does}</div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ ...handleY, right: inset }} />
    </div>
  );
});

/** Swimlane band of one workflow (spec §5 subgraphs); its title is drawn by LaneHeaders. */
export const LaneNode = memo(function LaneNode({ data }: NodeProps<Node<LaneData>>) {
  return <div className="ff-lane" style={{ width: data.width, height: data.height, "--lane": data.color } as CSSProperties} aria-hidden="true" />;
});

/**
 * Lane titles in a strip that follows the lanes vertically and zoom, but sticks to the left edge
 * when the canvas is panned to later steps, so every lane stays named.
 */
export function LaneHeaders({ lanes }: { lanes: LaneBox[] }) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  return (
    <div className="ff-lane-headers" aria-hidden="true">
      {lanes.map((l) => (
        <div
          key={l.id}
          className="ff-lane-label"
          // Laid out at graph scale, then scaled as a whole so text shrinks with the zoom instead of wrapping.
          style={{ width: LANE_LABEL_W - LANE_PAD_X / 2, height: l.height, transform: `translate(${Math.max(0, tx)}px, ${l.y * zoom + ty}px) scale(${zoom})`, "--lane": l.color } as CSSProperties}
        >
          <strong>{l.title}</strong>
          <span>{l.subtitle}</span>
        </div>
      ))}
    </div>
  );
}

const nodeTypes = { step: StepNode, lane: LaneNode };

/**
 * Hand-off between two steps, drawn like React Flow's smoothstep edge (dashed grey until the source
 * delivers, solid in the state colour after, animated while the target works) plus a label naming
 * what is handed over and its state. Hovering highlights it; the full sentence is its title.
 */
const FlowEdge = memo(function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<Edge<FlowEdgeData>>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10 });
  const kind = data?.kind ?? "idle";
  const faded = data?.faded ? " ff-edge-faded" : "";
  const title = `${data?.label ?? "Hand-off"}: ${data?.from ?? ""} → ${data?.to ?? ""} (${EDGE_STATE[kind]})`;
  return (
    <>
      <path d={path} className="ff-edge-hit" fill="none">
        <title>{title}</title>
      </path>
      <path id={id} d={path} className={`ff-edge ff-edge-${kind}${faded}`} fill="none" markerEnd={markerEnd} style={{ stroke: EDGE[kind] }} />
      {data?.label ? (
        <EdgeLabelRenderer>
          {/* The step's output, right after its card (like n8n's item count), not mid-way on long edges. */}
          <div
            className={`ff-edge-label ff-edge-label-${data.labelKind}${faded}`}
            style={{ transform: `translate(0, -50%) translate(${sourceX + 12}px, ${sourceY}px)`, "--edge": EDGE[data.labelKind] } as CSSProperties}
            title={`${data.label}: output of ${data.from} (${EDGE_STATE[data.labelKind]})`}
          >
            {EDGE_ICON[data.labelKind] ? <span aria-hidden="true">{EDGE_ICON[data.labelKind]}</span> : null}
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

const edgeTypes = { flow: FlowEdge };

/** The manual action a step offers on the canvas, from its current state. */
function actionFor(node: GraphNodeDto, nr: NodeRun | undefined, runId: string, open: () => void): NodeAction | undefined {
  switch (nr?.status) {
    case "waiting_for_input":
      // Document import and Figma hand-off need their panels; plain gates continue in one click.
      if (node.type === "readiness.read_api" || node.type === "tests.read_ba" || node.type === "figma.design") return { label: "Provide input →", primary: true, run: open };
      if (node.type === "readiness.review" || node.type === "tests.design")
        return { label: "Accept gaps", primary: true, run: () => api.invoke("runs:provideInput", { runId, nodeId: node.id, data: { accept: true } }), done: "Gaps accepted" };
      return { label: "Continue ▶", primary: true, run: () => api.invoke("runs:provideInput", { runId, nodeId: node.id, data: {} }), done: `Continuing ${node.label}` };
    case "failed":
    case "blocked":
    case "cancelled":
      return { label: "↻ Retry", primary: true, run: () => api.invoke("runs:retryNode", { runId, nodeId: node.id }), done: `Retrying ${node.label}` };
    case "running":
    case "retrying":
      return { label: "View live", run: open };
    case "passed":
    case "skipped":
      return { label: "Open", run: open };
    default:
      return undefined;
  }
}

/** State of what a step outputs: delivered once it passed, in progress while it runs. */
function outputKind(status: NodeRun["status"] | undefined): EdgeKind {
  switch (status) {
    case "passed":
    case "skipped":
      return "done";
    case "running":
    case "retrying":
      return "active";
    case "waiting_for_input":
      return "waiting";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "idle";
  }
}

function noteFor(nr: NodeRun | undefined, last: ActivityLine | undefined, labels: Map<string, string>): string | undefined {
  switch (nr?.status) {
    case undefined:
    case "pending":
      return "Not started";
    case "waiting_for_dependency":
      return `Waits for ${nr.waitingOn?.map((w) => labels.get(w) ?? w).join(", ")}`;
    case "waiting_for_input":
      return `Your turn · ${nr.blockerSummary ?? "input required"}`;
    case "blocked":
      return nr.blockerSummary;
    case "failed":
      return nr.error ? `${nr.error.code}: ${nr.error.message}` : "Failed";
    case "running":
    case "retrying":
      return last?.text ?? "Working…";
    default:
      return undefined;
  }
}


export interface LaneBox {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  y: number;
  height: number;
}

/**
 * One lane per stage, read like lines of text: top to bottom in the workflow's lane order, and
 * inside a lane left to right by the steps' order within that stage.
 * Only edges inside a lane set the columns, so every lane starts at the left edge and the whole
 * workflow stays compact enough to fit the window; hand-offs between stages go down to the next lane.
 * Steps of a lane sharing a column stack inside that lane.
 */
export function layout(
  graph: Pick<RunStateDto["graph"], "nodes" | "edges">,
  workflowLanes: Lane[],
  /** The workflow editor shows empty lanes too, so steps can be dropped in them. */
  options: { emptyLanes?: boolean } = {},
): { positions: Map<string, { x: number; y: number }>; lanes: LaneBox[]; width: number } {
  const laneOfNode = new Map(graph.nodes.map((n) => [n.id, laneFor(workflowLanes, n)?.id]));
  const incoming = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (laneOfNode.get(e.source) === laneOfNode.get(e.target)) incoming.get(e.target)?.push(e.source);
  const depth = new Map<string, number>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    depth.set(id, 0);
    const d = Math.max(-1, ...(incoming.get(id) ?? []).map(visit)) + 1;
    depth.set(id, d);
    return d;
  };
  graph.nodes.forEach((n) => visit(n.id));
  // A step with no input in its lane sits right before the first step it feeds, not in column 0:
  // otherwise its edge would cross the steps in between and look attached to them.
  for (const n of graph.nodes) {
    if (incoming.get(n.id)?.length) continue;
    const next = graph.edges.filter((e) => e.source === n.id && laneOfNode.get(e.target) === laneOfNode.get(n.id)).map((e) => depth.get(e.target) ?? 0);
    if (next.length) depth.set(n.id, Math.max(0, Math.min(...next) - 1));
  }

  const positions = new Map<string, { x: number; y: number }>();
  const lanes: LaneBox[] = [];
  let y = 0;
  for (const lane of workflowLanes) {
    const members = graph.nodes.filter((n) => laneOfNode.get(n.id) === lane.id);
    if (!members.length && !options.emptyLanes) continue;
    // Steps the user placed keep their spot (relative to the lane); the others are laid out in columns.
    const placed = members.filter((n) => n.position);
    const columns = new Map<number, string[]>();
    for (const n of members.filter((m) => !m.position)) {
      const col = depth.get(n.id) ?? 0;
      columns.set(col, [...(columns.get(col) ?? []), n.id]);
    }
    const rows = Math.max(1, ...[...columns.values()].map((c) => c.length));
    const content = Math.max(rows * ROW_H - (ROW_H - NODE_H), ...placed.map((n) => (n.position?.y ?? 0) + NODE_H));
    const height = content + 2 * LANE_PAD_Y;
    for (const n of placed) positions.set(n.id, { x: Math.max(LANE_LABEL_W, n.position?.x ?? 0), y: y + LANE_PAD_Y + Math.max(0, n.position?.y ?? 0) });
    for (const [col, ids] of columns) {
      // Stacks are centred in the lane; definition order is kept inside a stack.
      const top = y + LANE_PAD_Y + ((rows - ids.length) * ROW_H) / 2;
      ids.forEach((id, row) => positions.set(id, { x: LANE_LABEL_W + col * COL_W, y: top + row * ROW_H }));
    }
    lanes.push({ id: lane.id, title: lane.title, subtitle: lane.subtitle, color: lane.color, y, height });
    y += height + LANE_GAP;
  }
  const width = Math.max(0, ...[...positions.values()].map((p) => p.x)) + NODE_W + LANE_PAD_X;
  return { positions, lanes, width };
}
