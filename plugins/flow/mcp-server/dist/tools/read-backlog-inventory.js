/**
 * `readBacklogInventory` MCP tool — Story 3.6 HIGH-1 fix.
 *
 * Builds the backlog inventory server-side so the `/flow:plan` skill does
 * not need to enumerate `.yaml` files itself via the `Read` tool (which
 * requires known paths and cannot glob). The skill declares
 * `allowed_tools: [Task, readBacklogInventory]` and delegates enumeration
 * to this tool.
 *
 * Returns the typed `BacklogInventory` JSON the planner skill prose
 * consumes, including:
 *   - `mode`: `"first-run"` | `"re-open"`
 *   - `backlog_inventory`: array of `{ ref, title, state, withdrawn }`
 *
 * `MalformedExecutionManifestError` (and any other `parseExecutionManifest`
 * typed errors) are surfaced verbatim — this resolves MEDIUM-1 as well.
 *
 * Architecture reference: Story 3.6 reviewer HIGH-1.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { STATE_NAMES } from "../state/manifest-state-machine.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
export const ReadBacklogInventoryInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    /**
     * Optional single-item filter. When set, only the entry whose `ref` matches
     * is returned (the others are still scanned so `mode` stays accurate). The
     * gate-1 judge workflow passes this so it fetches exactly the draft under
     * judgement instead of relaying the whole backlog through a seam courier.
     */
    ref: z.string().min(1).optional(),
    /**
     * When true, each returned entry is enriched with `specText` (the draft's full
     * source markdown) and `riskTier` (the manifest's persisted `risk_tier`).
     * Default false keeps the inventory lean for its planner/board/dashboard
     * consumers — only the gate-1 judge workflow opts in, so the lens judges grade
     * the real draft (not an empty `"(spec text not available)"` placeholder).
     */
    includeSpecText: z.boolean().optional(),
});
/** ULID pattern: 26 characters from [0-9A-Z]. */
const ULID_PATTERN = /^[0-9A-Z]{26}$/;
/**
 * Extract the first H1 title from a native story Markdown file body.
 * Falls back to the filename (without extension) if no H1 is found.
 */
function extractH1Title(content, fallback) {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : fallback;
}
/**
 * Build the backlog inventory for the target repo.
 *
 * - Scans all four state directories (`to-do`, `in-progress`, `blocked`, `done`)
 *   for `.yaml` manifest files. Each is parsed via `parseExecutionManifest`
 *   (typed errors surface verbatim — not caught here).
 * - On the native-adapter branch only: also scans `.flow/native-stories/` for
 *   ULID-pattern `.md` files whose `native:<ULID>` ref does not already appear
 *   in the manifest inventory. Those entries get `state: "native-source-only"`,
 *   `withdrawn: false`, and `title` from the file's first H1.
 * - Derives `mode`: `"re-open"` if at least one entry exists, else `"first-run"`.
 *
 * @throws {MalformedExecutionManifestError} if any manifest fails schema validation.
 */
export async function readBacklogInventory(rawInput) {
    const input = ReadBacklogInventoryInputSchema.parse(rawInput);
    const targetRepoRoot = path.resolve(input.targetRepoRoot);
    // Resolve workspace to know the active adapter.
    const workspace = await resolveWorkspace({ targetRepoRoot });
    const isNative = workspace.activeAdapterName === "native";
    const stateRoot = path.join(targetRepoRoot, ".flow", "state");
    const doneDir = path.join(stateRoot, "done");
    const inventory = [];
    const seenRefs = new Set();
    // Scan each state directory.
    for (const stateName of STATE_NAMES) {
        const stateDir = path.join(stateRoot, stateName);
        let entries;
        try {
            entries = await fs.readdir(stateDir);
        }
        catch {
            // Directory does not exist yet — skip.
            continue;
        }
        for (const filename of entries) {
            // `<ref>.snapshot.yaml` is the anti-tamper baseline written alongside a
            // claimed manifest — it is NOT an execution manifest (no top-level `ref`),
            // so feeding it to `parseExecutionManifest` would throw and crash the board.
            if (!filename.endsWith(".yaml") || filename.endsWith(".snapshot.yaml"))
                continue;
            const absPath = path.join(stateDir, filename);
            const rawText = await fs.readFile(absPath, "utf8");
            const parsed = yamlParse(rawText);
            // `parseExecutionManifest` throws `MalformedExecutionManifestError` on
            // schema failure. Per the skill's `MalformedExecutionManifestError` failure
            // mode, the tool surfaces the error verbatim (not caught here).
            const manifest = parseExecutionManifest(parsed, { absPath });
            // depsReady mirrors listClaimableTodos: every dep present in done/.
            let depsReady = true;
            for (const dep of manifest.depends_on) {
                try {
                    await fs.stat(path.join(doneDir, `${dep}.yaml`));
                }
                catch {
                    depsReady = false;
                    break;
                }
            }
            const entry = {
                ref: manifest.ref,
                title: manifest.title,
                state: stateName,
                withdrawn: manifest.withdrawn,
                ready: manifest.ready,
                depsReady,
            };
            // Enrich with the real spec text + persisted risk tier only when asked,
            // and only for the entry the caller actually wants (so a `ref` filter does
            // not pay a file read for every other manifest). Resolve `source_path` the
            // same way the dev tool does (run-dev-terminal-action.ts): absolute as-is,
            // else relative to the repo root.
            if (input.includeSpecText && (!input.ref || manifest.ref === input.ref)) {
                const specAbs = path.isAbsolute(manifest.source_path)
                    ? manifest.source_path
                    : path.join(targetRepoRoot, manifest.source_path);
                try {
                    entry.specText = await fs.readFile(specAbs, "utf8");
                }
                catch {
                    // Source file missing/unreadable — leave specText undefined so the
                    // caller can tell "not requested" from "requested but unavailable"
                    // rather than masking it as an empty (but present) spec.
                }
                if (manifest.risk_tier)
                    entry.riskTier = manifest.risk_tier;
            }
            inventory.push(entry);
            seenRefs.add(manifest.ref);
        }
    }
    // Native-branch: supplement with source-only stories (no manifest yet).
    if (isNative) {
        const nativeStoriesDir = path.join(targetRepoRoot, ".flow", "native-stories");
        let nativeFiles;
        try {
            nativeFiles = await fs.readdir(nativeStoriesDir);
        }
        catch {
            nativeFiles = [];
        }
        for (const filename of nativeFiles) {
            if (!filename.endsWith(".md"))
                continue;
            const basename = filename.slice(0, -3); // strip .md
            if (!ULID_PATTERN.test(basename))
                continue;
            const ref = `native:${basename}`;
            if (seenRefs.has(ref))
                continue; // already covered by a manifest
            const absPath = path.join(nativeStoriesDir, filename);
            const content = await fs.readFile(absPath, "utf8");
            const title = extractH1Title(content, basename);
            const entry = {
                ref,
                title,
                state: "native-source-only",
                withdrawn: false,
                ready: false,
                depsReady: true,
            };
            // The native-stories file content is already in hand (read for the title),
            // so enriching specText is free. No manifest yet → no persisted riskTier.
            if (input.includeSpecText && (!input.ref || ref === input.ref)) {
                entry.specText = content;
            }
            inventory.push(entry);
        }
    }
    // `mode` describes the whole backlog, so derive it BEFORE applying the optional
    // single-item `ref` filter.
    const mode = inventory.length === 0 ? "first-run" : "re-open";
    const backlog_inventory = input.ref
        ? inventory.filter((e) => e.ref === input.ref)
        : inventory;
    return { mode, backlog_inventory };
}
