import type { FigmaSource } from "./figma-source.js";
import type { FigmaScope, NodeRef, NodeTree } from "./types.js";

export class ScopeViolationError extends Error {
  constructor(
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

interface NodeEntry {
  /** null = top of the document reached; undefined = parent unknown. */
  parentId: string | null | undefined;
  type?: string;
}

const TOP_TYPES = new Set(["PAGE", "DOCUMENT", "CANVAS"]);

/**
 * Restricts Figma access to a bound file/page/node subtree (§13.1).
 * A node is in scope when it (or an ancestor) is a root node and (or an ancestor) is an allowed page.
 * Ancestry is learned from trees the plugin returns; unknown links are resolved via getNodeAncestors.
 */
export class ScopeGuard {
  private readonly files = new Map<string, Map<string, NodeEntry>>();

  assertFile(scope: FigmaScope | undefined, fileKey: string | undefined): void {
    if (!scope) return;
    if (!fileKey || fileKey !== scope.fileKey) {
      throw new ScopeViolationError(`Figma file ${fileKey ?? "(none)"} is outside the bound scope`);
    }
  }

  async assertNode(
    scope: FigmaScope | undefined,
    fileKey: string | undefined,
    nodeId: string,
    source?: Pick<FigmaSource, "getNodeAncestors">,
  ): Promise<void> {
    if (!(await this.isAllowed(scope, fileKey, nodeId, source))) {
      throw new ScopeViolationError(`Node ${nodeId} is outside the bound Figma scope`, nodeId);
    }
  }

  async isAllowed(
    scope: FigmaScope | undefined,
    fileKey: string | undefined,
    nodeId: string,
    source?: Pick<FigmaSource, "getNodeAncestors">,
  ): Promise<boolean> {
    if (!scope) return true;
    if (!fileKey || fileKey !== scope.fileKey) return false;
    const roots = scope.rootNodeIds?.length ? new Set(scope.rootNodeIds) : undefined;
    const pages = scope.pageIds?.length ? new Set(scope.pageIds) : undefined;
    if (!roots && !pages) return true;

    const cached = this.chain(fileKey, nodeId);
    if (satisfies(cached.ids, roots, pages)) return true;
    if (cached.complete) return false;
    if (!source) return false;

    const ancestors = await source.getNodeAncestors(nodeId);
    this.observeAncestors(fileKey, nodeId, ancestors);
    return satisfies([nodeId, ...ancestors.map((a) => a.nodeId)], roots, pages);
  }

  observeTree(fileKey: string, tree: NodeTree): void {
    const nodes = this.nodes(fileKey);
    const visit = (node: NodeTree, parentId: string | null | undefined, depth: number): void => {
      if (depth > 200) return;
      const existing = nodes.get(node.nodeId);
      const resolvedParent = parentId !== undefined ? parentId : (node.parentId ?? existing?.parentId);
      nodes.set(node.nodeId, { parentId: resolvedParent, type: node.type });
      for (const child of node.children ?? []) visit(child, node.nodeId, depth + 1);
    };
    visit(tree, tree.parentId, 0);
  }

  observeRefs(fileKey: string, refs: NodeRef[]): void {
    const nodes = this.nodes(fileKey);
    for (const ref of refs) {
      const existing = nodes.get(ref.nodeId);
      nodes.set(ref.nodeId, { parentId: ref.parentId ?? existing?.parentId, type: ref.type });
    }
  }

  /** `ancestors` runs from the direct parent upwards. */
  observeAncestors(fileKey: string, nodeId: string, ancestors: NodeRef[]): void {
    const nodes = this.nodes(fileKey);
    const chain = [nodeId, ...ancestors.map((a) => a.nodeId)];
    for (let i = 0; i < chain.length; i++) {
      const id = chain[i]!;
      const parent = chain[i + 1];
      const existing = nodes.get(id);
      const type = i === 0 ? existing?.type : ancestors[i - 1]?.type;
      const entry: NodeEntry = { parentId: parent ?? null };
      if (type) entry.type = type;
      nodes.set(id, entry);
    }
  }

  invalidate(fileKey?: string): void {
    if (fileKey === undefined) this.files.clear();
    else this.files.delete(fileKey);
  }

  private chain(fileKey: string, nodeId: string): { ids: string[]; complete: boolean } {
    const nodes = this.files.get(fileKey);
    const ids = [nodeId];
    if (!nodes) return { ids, complete: false };
    const seen = new Set(ids);
    let current = nodeId;
    for (;;) {
      const entry = nodes.get(current);
      if (entry?.type && TOP_TYPES.has(entry.type)) return { ids, complete: true };
      if (!entry || entry.parentId === undefined) return { ids, complete: false };
      if (entry.parentId === null) return { ids, complete: true };
      if (seen.has(entry.parentId)) return { ids, complete: false };
      current = entry.parentId;
      seen.add(current);
      ids.push(current);
    }
  }

  private nodes(fileKey: string): Map<string, NodeEntry> {
    let nodes = this.files.get(fileKey);
    if (!nodes) {
      nodes = new Map();
      this.files.set(fileKey, nodes);
    }
    return nodes;
  }
}

function satisfies(ids: string[], roots: Set<string> | undefined, pages: Set<string> | undefined): boolean {
  const rootOk = !roots || ids.some((id) => roots.has(id));
  const pageOk = !pages || ids.some((id) => pages.has(id));
  return rootOk && pageOk;
}
