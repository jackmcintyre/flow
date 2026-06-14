/**
 * `extractNativeStoryAcs` CLI tool — Story native:01KT6QGBWP7KJDVMHQK3MEKDXP (AC2).
 *
 * Reads a native story spec from the orchestrating checkout's
 * `.flow/native-stories/<ULID>.md` folder and returns the structured
 * acceptance criteria. Called by the drain BEFORE spawning the builder worktree,
 * so the builder receives its ACs inline and never needs to resolve a `.flow`
 * path from within its isolated work copy.
 *
 * Native story specs live in `.flow/native-stories/` which is gitignored —
 * present only in the orchestrating checkout, not in builder worktrees. This
 * tool runs on the orchestrating side (where `.flow` exists) and returns the
 * ACs as structured JSON so the drain can pass them inline to the builder.
 *
 * Usage (via CLI seam):
 *   node dist/cli.js extractNativeStoryAcs --json '{"targetRepoRoot":"...","ref":"native:01KT..."}'
 *
 * Returns:
 *   { acs: Array<{ index: number; firstLine: string; tag: string|null; body: string[] }> }
 *
 * Fail-soft: if the spec file does not exist or cannot be parsed, returns
 * { acs: [] } so the drain degrades gracefully (the builder falls back to its
 * existing file-read path, which will surface the "file not found" as a clear
 * error rather than a silent wrong result).
 */

import * as path from "node:path";
import { extractAcsFromSpec, type AcEntry } from "../lib/extract-acs-from-spec.js";

/**
 * Extract acceptance criteria from a native story spec.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repo (the orchestrating checkout).
 * @param opts.ref            - Story reference, e.g. `native:01KT...`. The `native:` prefix
 *                             is stripped to derive the ULID used for the spec filename.
 * @returns `{ acs }` where `acs` is the structured array of AC entries, or an
 *          empty array when the spec cannot be read.
 */
export async function extractNativeStoryAcs(opts: {
  targetRepoRoot: string;
  ref: string;
}): Promise<{ acs: AcEntry[] }> {
  const { targetRepoRoot, ref } = opts;

  // Derive the ULID from the ref: strip the `native:` prefix.
  // If the ref is not in `native:<ULID>` format, the path will not resolve and
  // the catch below will return an empty acs array (fail-soft).
  const ulid = ref.startsWith("native:") ? ref.slice("native:".length) : ref;
  const specPath = path.join(targetRepoRoot, ".flow", "native-stories", `${ulid}.md`);

  try {
    const acs = await extractAcsFromSpec(specPath);
    return { acs };
  } catch {
    // Fail-soft: if the spec cannot be read (file not found, parse error, etc.),
    // return an empty array. The drain degrades gracefully — the builder falls
    // back to its own file-read path, which surfaces a clear file-not-found error
    // rather than a silent wrong result.
    return { acs: [] };
  }
}
