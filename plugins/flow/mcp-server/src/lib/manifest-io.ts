/**
 * Shared utility for reading and writing in-progress execution manifests.
 * Used by `processDevTranscript` and `processReviewerTranscript`.
 *
 * Story 4.3b Task 7 — extracted from `run-dev-session.ts` helpers
 * `readManifestFromDisk` / `writeManifestToDisk`.
 *
 * All manifest writes route through `atomicWriteFile` (Story 1.6's primitive)
 * per the canonical-fs-guard constraint.
 */

import { promises as fs } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { atomicWriteFile } from "./managed-fs.js";
import type { ExecutionManifest } from "../schemas/execution-manifest.js";

/**
 * Read and parse an execution manifest from disk.
 *
 * @param absPath - Absolute path to the manifest YAML file.
 * @returns Parsed and schema-validated `ExecutionManifest`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema validation.
 */
export async function readManifest(absPath: string): Promise<ExecutionManifest> {
  const raw = await fs.readFile(absPath, "utf8");
  const parsed = yamlParse(raw) as unknown;
  return parseExecutionManifest(parsed, { absPath });
}

/**
 * Write an execution manifest back to disk atomically.
 *
 * Uses `atomicWriteFile` (Story 1.6's primitive) — the only sanctioned
 * manifest write surface in v1.
 *
 * @param absPath - Absolute path to write the manifest YAML file.
 * @param manifest - The manifest object to serialise and write.
 */
export async function writeManifest(
  absPath: string,
  manifest: ExecutionManifest,
): Promise<void> {
  const yaml = yamlStringify(manifest, { lineWidth: 0 });
  await atomicWriteFile(absPath, yaml);
}
