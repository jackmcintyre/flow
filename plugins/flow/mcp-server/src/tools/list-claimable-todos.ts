/**
 * `listClaimableTodos` MCP tool — Story 4.2 Task 3.
 *
 * Enumerates `.flow/state/to-do/<ref>.yaml` files, parses each via
 * `parseExecutionManifest`, filters by `isClaimable`, and emits a sorted
 * (alphabetical ref order) projection used by the `/flow:start` skill.
 *
 * The return shape also includes `inProgressCount` so the skill can decide
 * the queue-drained condition without a separate filesystem call.
 *
 * Per-candidate `depsReady` is computed by statting
 * `<targetRepoRoot>/.flow/state/done/<dep>.yaml` for each dep in
 * `depends_on`. If all present, `depsReady: true`.
 *
 * No write side-effects. Propagates `MalformedExecutionManifestError` verbatim.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `listClaimableTodos`.
 * Story 4.2 Task 3.1–3.5.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { isClaimable } from "../state/manifest-state-machine.js";
import { shortHandle } from "../lib/short-handle.js";

interface ClaimableCandidate {
  /** Story ref, e.g. `"native:01HZ..."` or `"bmad:1.1"`. */
  ref: string;
  /**
   * Short human-friendly display handle derived from the ref.
   * For a `native:<ULID>` ref this is the first 8 characters of the ULID.
   * For any other ref (e.g. `bmad:8.18`) this is the local part after the
   * first `:`. Always non-empty. Use this on operator-facing surfaces instead
   * of the full ref.
   */
  shortHandle: string;
  /** Human-readable title from the manifest. */
  title: string;
  /** Dependency refs from the manifest. */
  depends_on: readonly string[];
  /**
   * True iff all `depends_on` refs are present in `<targetRepoRoot>/.flow/state/done/`.
   * False if any dep is missing. The `/flow:start` skill claims only refs where
   * `depsReady: true` on a given pass.
   */
  depsReady: boolean;
  /**
   * Operator readiness flag carried through verbatim from the parsed manifest
   * (Story 9.1). The claim entry point (`claimNextStory`) requires BOTH
   * `depsReady` AND `ready` before a candidate is eligible — a candidate that
   * is deps-ready but not operator-blessed is listed here (so the intake
   * cockpit can show it) but is never claimed.
   */
  ready: boolean;
}

export interface ListClaimableTodosResult {
  todos: ClaimableCandidate[];
  /** Count of `.yaml` files currently in `<targetRepoRoot>/.flow/state/in-progress/`. */
  inProgressCount: number;
}

export interface ListClaimableTodosOptions {
  targetRepoRoot: string;
}

/**
 * List all claimable candidates from `<targetRepoRoot>/.flow/state/to-do/`
 * in stable alphabetical ref order, along with the count of in-progress manifests.
 *
 * @throws {MalformedExecutionManifestError} When any manifest fails schema validation.
 */
export async function listClaimableTodos(
  opts: ListClaimableTodosOptions,
): Promise<ListClaimableTodosResult> {
  const { targetRepoRoot } = opts;
  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const todoDir = path.join(stateRoot, "to-do");
  const inProgressDir = path.join(stateRoot, "in-progress");
  const doneDir = path.join(stateRoot, "done");

  // Read to-do/ directory.
  let todoEntries: string[];
  try {
    todoEntries = await fs.readdir(todoDir);
  } catch (err) {
    if (isEnoent(err)) {
      todoEntries = [];
    } else {
      throw err;
    }
  }

  // Filter to .yaml files and sort alphabetically (by filename = ref + .yaml).
  const yamlEntries = todoEntries
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  const candidates: ClaimableCandidate[] = [];

  for (const entry of yamlEntries) {
    const absPath = path.join(todoDir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        // File vanished between readdir and readFile — skip silently.
        continue;
      }
      throw err;
    }

    const parsed = yamlParse(raw) as unknown;
    // parseExecutionManifest throws MalformedExecutionManifestError on invalid shape.
    const manifest = parseExecutionManifest(parsed, { absPath });

    if (!isClaimable(manifest)) {
      continue;
    }

    // Check dep readiness: stat done/<dep>.yaml for each dep.
    let depsReady = true;
    for (const dep of manifest.depends_on) {
      const depPath = path.join(doneDir, `${dep}.yaml`);
      try {
        await fs.stat(depPath);
      } catch (err) {
        if (isEnoent(err)) {
          depsReady = false;
          break;
        }
        throw err;
      }
    }

    candidates.push({
      ref: manifest.ref,
      shortHandle: shortHandle(manifest.ref),
      title: manifest.title,
      depends_on: manifest.depends_on,
      depsReady,
      ready: manifest.ready,
    });
  }

  // Count in-progress manifests.
  let inProgressCount = 0;
  try {
    const inProgressEntries = await fs.readdir(inProgressDir);
    // Exclude `<ref>.snapshot.yaml` companion files (written alongside the real
    // manifest when a story is claimed) — they are not manifests, so counting
    // them would double the reported in-progress count.
    inProgressCount = inProgressEntries.filter(
      (f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"),
    ).length;
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
    // Directory absent → 0.
  }

  return { todos: candidates, inProgressCount };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
