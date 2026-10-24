/** Spec §11.3; `ops_markdown`: a feature's test operations guide (e.g. how to prepare data in the CMS). */
export type SourceSnapshotType = "ba_markdown" | "api_markdown" | "ops_markdown" | "openapi" | "figma";

export interface SourceSnapshot {
  id: string;
  type: SourceSnapshotType;
  sourceUri?: string;
  contentHash: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/** Points back to the exact place in an input document a fact came from. */
export interface SourceReference {
  snapshotId: string;
  /** 1-based line range in the snapshot content. */
  lineStart: number;
  lineEnd: number;
  /** Heading path, e.g. ["Requirements", "BA-ORDER-001 — Customer cancels"]. */
  section?: string[];
  excerpt?: string;
}
