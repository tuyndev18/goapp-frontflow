import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { sha256 } from "@frontflow/domain";
import type { ExportedAsset } from "./types.js";

export interface WrittenAsset {
  nodeId: string;
  format: string;
  path: string;
  bytes: number;
  sha256: string;
}

/** Destination for export_assets output. */
export interface AssetWriter {
  write(asset: ExportedAsset, context: { sessionId: string }): Promise<WrittenAsset>;
}

export function safeFileSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return (cleaned || "asset").slice(0, 120);
}

/** Writes exported assets to `<rootDir>/<sessionId>/<name>.<format>`. Names are sanitised; paths cannot escape rootDir. */
export function createFileAssetWriter(rootDir: string): AssetWriter {
  const root = resolve(rootDir);
  return {
    async write(asset, context) {
      const dir = join(root, safeFileSegment(context.sessionId));
      const base = safeFileSegment(asset.fileName?.replace(/\.(png|svg)$/i, "") ?? `node-${asset.nodeId}`);
      const path = resolve(dir, `${base}.${asset.format}`);
      if (!path.startsWith(root + sep)) throw new Error("Refusing to write asset outside the asset directory");
      const data = Buffer.from(asset.base64, "base64");
      await mkdir(dir, { recursive: true });
      await writeFile(path, data);
      return { nodeId: asset.nodeId, format: asset.format, path, bytes: data.length, sha256: sha256(data) };
    },
  };
}
