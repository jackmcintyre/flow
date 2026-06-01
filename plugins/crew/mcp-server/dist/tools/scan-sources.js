import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { extractDepRefsFromSpecBody } from "../lib/extract-dep-refs.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { ExecutionManifestSchema, parseExecutionManifest, } from "../schemas/execution-manifest.js";
import { STATE_NAMES } from "../state/manifest-state-machine.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
/**
 * Render a `ScanResult` as a human-readable text summary.
 * The tool returns this string verbatim; the `/crew:scan` skill
 * prints it without paraphrase or omission.
 */
export function renderScanResult(result) {
    const lines = [
        `scan-sources completed for ${result.targetRepoRoot}`,
        `adapter: ${result.adapterName}`,
        ``,
        `created:   ${result.createdRefs.length} ref(s)${result.createdRefs.length > 0 ? " — " + result.createdRefs.join(", ") : ""}`,
        `updated:   ${result.updatedRefs.length} ref(s)${result.updatedRefs.length > 0 ? " — " + result.updatedRefs.join(", ") : ""}`,
        `unchanged: ${result.unchangedRefs.length} ref(s)${result.unchangedRefs.length > 0 ? " — " + result.unchangedRefs.join(", ") : ""}`,
    ];
    // Omit discipline-violation refs from the skipped line when they are already
    // named in the blocked line — they're the same refs and printing both causes
    // confusion about whether they're separate problems.
    const blockedRefSet = new Set(result.blockedRefs ?? []);
    const skippedForDisplay = result.skippedRefs.filter((s) => !(s.reason === "discipline-violation" && blockedRefSet.has(s.ref)));
    if (skippedForDisplay.length > 0) {
        lines.push(`skipped:   ${skippedForDisplay.length} ref(s) — ` +
            skippedForDisplay
                .map((s) => `${s.ref} (${s.reason}${s.detail ? ": " + s.detail : ""})`)
                .join(", "));
    }
    else {
        lines.push(`skipped:   0 ref(s)`);
    }
    // Story 5.13: deps-drift lines — emitted BEFORE the blocked summary line so the
    // operator sees the more-actionable signal first (per Implementation Strategy § 3).
    const depsDriftRefs = result.depsDriftRefs ?? [];
    for (const entry of depsDriftRefs) {
        const proseSet = `{${entry.proseRefs.sort().join(", ")}}`;
        const manifestSet = `{${entry.manifestRefs.sort().join(", ")}}`;
        lines.push(`[deps-drift] ${entry.ref} — prose: ${proseSet}, manifest: ${manifestSet}`);
    }
    // Story 3.5 Task 6.3: blocked refs line (operator-facing surface).
    // A blocked ref here is the operator's cue to fix the source story
    // (add an integration AC, declare missing depends_on, etc.) and re-run /crew:scan.
    if ((result.blockedRefs ?? []).length > 0) {
        lines.push(`blocked:   ${result.blockedRefs.length} ref(s) — ` +
            result.blockedRefs.join(", ") +
            ` (planning-discipline violation — fix the source story and re-run /crew:scan)`);
    }
    else {
        lines.push(`blocked:   0 ref(s)`);
    }
    return lines.join("\n");
}
/**
 * Check whether a path exists on disk; returns null if not found.
 */
async function statOrNull(absPath) {
    try {
        return await fs.stat(absPath);
    }
    catch {
        return null;
    }
}
/**
 * Compute the repo-relative path from `rawPath` if it falls strictly inside
 * `targetRepoRoot`; otherwise return the absolute path as-is.
 * Avoids leaking absolute paths into committed manifests.
 */
function repoRelativePath(rawPath, targetRepoRoot) {
    const rel = path.relative(targetRepoRoot, rawPath);
    // If `rel` starts with ".." or is absolute, the path escapes the repo root.
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return rawPath;
    }
    return rel;
}
/**
 * Strip keys with `undefined` values from a plain object before YAML
 * stringification. Prevents `implementation_notes: ~` appearing in on-disk
 * YAML when the field is absent in the source story.
 */
function stripUndefined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
/**
 * Compute the symmetric difference between two sets.
 * Returns `{ onlyInA, onlyInB }` — both empty means no drift.
 */
function symmetricDiff(a, b) {
    const onlyInA = [...a].filter((x) => !b.has(x));
    const onlyInB = [...b].filter((x) => !a.has(x));
    return { onlyInA, onlyInB };
}
/**
 * Check whether prose deps in the spec body drift from `story.depends_on`.
 * Re-reads the raw spec file from `story.raw_path`.
 *
 * Returns `null` when there is no drift (prose and manifest agree).
 * Returns `{ proseRefs, manifestRefs }` when the symmetric difference is non-empty.
 */
async function checkDepsDrift(story) {
    let body;
    try {
        body = await fs.readFile(story.raw_path, "utf8");
    }
    catch {
        // If the file is unreadable, skip the drift check — don't false-positive block.
        return null;
    }
    const proseSet = extractDepRefsFromSpecBody(body);
    const manifestSet = new Set(story.depends_on);
    const { onlyInA: onlyInProse, onlyInB: onlyInManifest } = symmetricDiff(proseSet, manifestSet);
    if (onlyInProse.length === 0 && onlyInManifest.length === 0) {
        return null;
    }
    // Symmetric difference: proseRefs is everything prose sees; manifestRefs is everything manifest sees.
    return {
        proseRefs: [...proseSet].sort(),
        manifestRefs: [...manifestSet].sort(),
    };
}
/**
 * Write a `blocked/` manifest with `blocked_by: "deps-drift"`.
 */
async function writeDepsDriftBlockedManifest(story, driftDetail, absBlockedPath, activeAdapterName, targetRepoRoot) {
    const blockedManifestRaw = stripUndefined({
        ref: story.ref,
        status: "blocked",
        adapter: activeAdapterName,
        source_path: repoRelativePath(story.raw_path, targetRepoRoot),
        source_hash: story.source_hash,
        depends_on: story.depends_on,
        acceptance_criteria: story.acceptance_criteria,
        title: story.title,
        narrative: story.narrative,
        narrative_struct: story.narrative_struct,
        tasks: story.tasks,
        cited_sources: story.cited_sources,
        implementation_notes: story.implementation_notes,
        withdrawn: false,
        blocked_by: "deps-drift",
        discipline_violations: [
            {
                code: "deps-drift-prose-vs-manifest",
                field: "depends_on",
                detail: `Prose deps: [${driftDetail.proseRefs.join(", ")}]; Manifest deps: [${driftDetail.manifestRefs.join(", ")}]`,
            },
        ],
    });
    const blockedManifest = ExecutionManifestSchema.parse(blockedManifestRaw);
    const yamlText = yamlStringify(blockedManifest, { lineWidth: 0 });
    await writeManagedFile({
        absPath: absBlockedPath,
        contents: yamlText,
        targetRepoRoot,
        mcpToolContext: { toolName: "scanSources", role: "operator" },
    });
}
/**
 * Compose a new `ExecutionManifest` object from a `SourceStory`.
 * Validates through the schema defensively — catches coding mistakes in
 * the composer before writing to disk.
 */
function composeManifest(story, adapterName, targetRepoRoot) {
    const raw = stripUndefined({
        ref: story.ref,
        status: "to-do",
        adapter: adapterName,
        source_path: repoRelativePath(story.raw_path, targetRepoRoot),
        source_hash: story.source_hash,
        depends_on: story.depends_on,
        acceptance_criteria: story.acceptance_criteria,
        title: story.title,
        narrative: story.narrative,
        // Story 10.2 — additive native-format fields. `undefined` (stripped) for
        // BMad-scanned stories; carried through for native-scanned ones.
        narrative_struct: story.narrative_struct,
        tasks: story.tasks,
        cited_sources: story.cited_sources,
        implementation_notes: story.implementation_notes,
        withdrawn: false,
        // Story 9.1 — the readiness brake. A freshly-scanned item is in to-do/ but
        // NOT claimable until the operator blesses it (markStoryReady / /crew:ready).
        // Written explicitly (not left to the schema default) so the on-disk manifest
        // visibly carries the brake and round-trips stably.
        ready: false,
    });
    // Defensive parse — throws if the composer produced an invalid shape.
    return ExecutionManifestSchema.parse(raw);
}
/**
 * Project the active adapter's source stories into per-story execution
 * manifests under `<targetRepoRoot>/.crew/state/to-do/<ref>.yaml`.
 *
 * **Idempotency (AC2 / NFR10):** On a re-scan with no source changes, this
 * function writes nothing. "Not rewritten" is load-bearing: the dev loop's
 * polling semantics detect work by mtime changes. Re-writing byte-identical
 * content would produce spurious mtime updates and corrupt the polling.
 *
 * **Hash-refresh (AC3):** If a source story's hash changed AND its manifest
 * is still in `to-do/`, the manifest is rewritten with the new hash and
 * updated `source_path`. All other fields (including any operator hand-edits
 * to `narrative`, `acceptance_criteria`, or `withdrawn`) are preserved.
 *
 * **Claim isolation (AC3 negative):** Manifests in `in-progress/`, `blocked/`,
 * or `done/` are NEVER touched. They are owned by the dev loop / orchestrator.
 * `scan-sources` only ever writes into `to-do/`.
 *
 * **Concurrency:** v1 assumes at most one `scan-sources` invocation per
 * target repo at a time. The MCP server is single-process; concurrent
 * invocations are out of scope. Do NOT add a lock here — see Story 4.x's
 * claim flow for the locking design.
 *
 * **`validateAgainstDiscipline` seam:** The call at step 3 is a documented
 * seam for Story 3.5. In v1, every adapter's implementation is pass-through
 * (returns the input story unchanged). Story 3.5 will make some adapters
 * return a `DisciplineViolation` — at that point the `skippedRefs` path
 * with `reason: "discipline-violation"` will light up without any change to
 * this file.
 */
export async function scanSources(opts) {
    // Step 1: Resolve the workspace. Throws on misconfiguration.
    const workspace = await resolveWorkspace({ targetRepoRoot: opts.targetRepoRoot });
    const { activeAdapter, activeAdapterName, adapterConfig, targetRepoRoot } = workspace;
    // Step 2: List source stories from the active adapter.
    const sourceStories = await activeAdapter.listSourceStories();
    const result = {
        targetRepoRoot,
        adapterName: activeAdapterName,
        createdRefs: [],
        updatedRefs: [],
        unchangedRefs: [],
        skippedRefs: [],
        blockedRefs: [],
        depsDriftRefs: [],
    };
    const stateRoot = path.join(targetRepoRoot, ".crew", "state");
    // Startup guard: resolve any refs that appear in both to-do/ and blocked/
    // simultaneously. This can occur if a previous blocked→to-do promotion wrote
    // the to-do manifest successfully but the subsequent unlink of the blocked
    // manifest failed (non-atomic write sequence). When both exist, to-do/ wins —
    // delete the stale blocked/ manifest and log a warning so the operator is
    // aware of the recovery. This guard prevents the inconsistency from persisting
    // across subsequent scans.
    {
        const toDoDir = path.join(stateRoot, "to-do");
        const blockedDir = path.join(stateRoot, "blocked");
        let toDoFiles = [];
        let blockedFiles = [];
        try {
            toDoFiles = await fs.readdir(toDoDir);
        }
        catch {
            // Directory may not exist yet on a fresh repo — not an error.
        }
        try {
            blockedFiles = await fs.readdir(blockedDir);
        }
        catch {
            // Directory may not exist yet on a fresh repo — not an error.
        }
        const toDoRefs = new Set(toDoFiles.filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)));
        for (const blockedFile of blockedFiles) {
            if (!blockedFile.endsWith(".yaml"))
                continue;
            const ref = blockedFile.slice(0, -5);
            if (toDoRefs.has(ref)) {
                console.warn(`[scanSources] Ref ${ref} exists in both to-do/ and blocked/ — recovering by removing stale blocked/ manifest (to-do/ wins).`);
                await fs.unlink(path.join(blockedDir, blockedFile));
            }
        }
    }
    // Step 3 + 4 + 5: For each story, check presence map, validate discipline,
    // then branch on create/blocked-create/update/unchanged/skip.
    //
    // IMPORTANT: The presence check happens FIRST (before discipline). This
    // preserves the "scan does not touch claimed work" invariant for ALL state
    // dirs including `blocked/`. A story already in blocked/ (from a prior scan)
    // is treated as claimed and skipped with reason "not-in-to-do", exactly like
    // stories in in-progress/ or done/. Only if no manifest exists anywhere does
    // the discipline check run and potentially write to blocked/.
    for (const story of sourceStories) {
        // Step 3: Check which state dir this ref's manifest lives in, if any.
        let currentState = null;
        for (const stateName of STATE_NAMES) {
            const absPath = path.join(stateRoot, stateName, `${story.ref}.yaml`);
            const s = await statOrNull(absPath);
            if (s !== null) {
                currentState = stateName;
                break;
            }
        }
        // Step 4: Handle manifests that exist outside to-do/.
        //
        // - in-progress/ or done/: the dev loop owns it — skip unconditionally.
        // - blocked/: re-run the discipline validator. If the source story has been
        //   fixed (validator now passes), promote to to-do/ and delete the blocked
        //   manifest. If it still fails, rewrite the blocked manifest to record the
        //   latest source_hash and updated violations. This is the remediation flow
        //   described in README-install.md § Planning-discipline enforcement.
        if (currentState === "in-progress" || currentState === "done") {
            result.skippedRefs.push({
                ref: story.ref,
                reason: "not-in-to-do",
            });
            continue;
        }
        if (currentState === "blocked") {
            // Read the existing blocked manifest to check whether the source has changed.
            const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
            const rawBlocked = await fs.readFile(absBlockedPath, "utf8");
            const parsedBlocked = yamlParse(rawBlocked);
            const existingBlockedHash = parsedBlocked["source_hash"];
            if (existingBlockedHash === story.source_hash) {
                // Source unchanged — no need to re-evaluate. Skip quietly.
                result.skippedRefs.push({ ref: story.ref, reason: "not-in-to-do" });
                continue;
            }
            // Source hash changed (operator edited the story).
            // Story 5.13: check deps-drift FIRST (more-actionable signal before discipline).
            const driftDetail = await checkDepsDrift(story);
            if (driftDetail !== null) {
                // Still drifting (or now drifting for the first time) — rewrite blocked manifest.
                await writeDepsDriftBlockedManifest(story, driftDetail, absBlockedPath, activeAdapterName, targetRepoRoot);
                result.skippedRefs.push({
                    ref: story.ref,
                    reason: "discipline-violation",
                    detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
                });
                result.blockedRefs.push(story.ref);
                result.depsDriftRefs.push({
                    ref: story.ref,
                    proseRefs: driftDetail.proseRefs,
                    manifestRefs: driftDetail.manifestRefs,
                });
                continue;
            }
            // No deps-drift — re-run discipline.
            const disciplineResult = activeAdapter.validateAgainstDiscipline(story);
            if (!("kind" in disciplineResult) || disciplineResult.kind !== "discipline-violation") {
                // Story now passes both deps-drift and discipline — promote from blocked/ to to-do/.
                // NOTE: This sequence is non-atomic: the to-do/ manifest is written
                // first, then the blocked/ manifest is deleted. If the unlink fails
                // (e.g. a mid-flight crash or permission error), both manifests will
                // exist simultaneously. The startup guard above detects and recovers
                // this state on the next scan (to-do/ wins, blocked/ is deleted).
                const absToDoPathNew = path.join(stateRoot, "to-do", `${story.ref}.yaml`);
                const manifest = composeManifest(story, activeAdapterName, targetRepoRoot);
                const yamlText = yamlStringify(manifest, { lineWidth: 0 });
                await writeManagedFile({
                    absPath: absToDoPathNew,
                    contents: yamlText,
                    targetRepoRoot,
                    mcpToolContext: { toolName: "scanSources", role: "operator" },
                });
                await fs.unlink(absBlockedPath);
                result.createdRefs.push(story.ref);
            }
            else {
                // Still failing discipline — rewrite the blocked manifest with updated hash and violations.
                const blockedManifestRaw = stripUndefined({
                    ref: story.ref,
                    status: "blocked",
                    adapter: activeAdapterName,
                    source_path: repoRelativePath(story.raw_path, targetRepoRoot),
                    source_hash: story.source_hash,
                    depends_on: story.depends_on,
                    acceptance_criteria: story.acceptance_criteria,
                    title: story.title,
                    narrative: story.narrative,
                    narrative_struct: story.narrative_struct,
                    tasks: story.tasks,
                    cited_sources: story.cited_sources,
                    implementation_notes: story.implementation_notes,
                    withdrawn: false,
                    blocked_by: "planning-discipline",
                    discipline_violations: disciplineResult.violations.map((v) => ({
                        code: v.code,
                        field: v.field,
                        detail: v.detail,
                    })),
                });
                const blockedManifest = ExecutionManifestSchema.parse(blockedManifestRaw);
                const yamlText = yamlStringify(blockedManifest, { lineWidth: 0 });
                await writeManagedFile({
                    absPath: absBlockedPath,
                    contents: yamlText,
                    targetRepoRoot,
                    mcpToolContext: { toolName: "scanSources", role: "operator" },
                });
                const firstViolation = disciplineResult.violations[0];
                result.skippedRefs.push({
                    ref: story.ref,
                    reason: "discipline-violation",
                    detail: firstViolation?.detail,
                });
                result.blockedRefs.push(story.ref);
            }
            continue;
        }
        // Step 5: deps-drift gate (Story 5.13 — new, runs BEFORE discipline for more-actionable signal).
        // Then validateAgainstDiscipline (Story 3.5 — real enforcement).
        // Only runs when no manifest exists anywhere (currentState === null) or
        // when the manifest is already in to-do/ (currentState === "to-do").
        // For the to-do case, both gates are no-ops (the story already passed at first scan).
        if (currentState === null) {
            // Story 5.13: deps-drift gate — runs before discipline so operator sees the
            // more-actionable signal first (a drift is a planner-author mistake).
            const driftDetail = await checkDepsDrift(story);
            if (driftDetail !== null) {
                const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
                await writeDepsDriftBlockedManifest(story, driftDetail, absBlockedPath, activeAdapterName, targetRepoRoot);
                result.skippedRefs.push({
                    ref: story.ref,
                    reason: "discipline-violation",
                    detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
                });
                result.blockedRefs.push(story.ref);
                result.depsDriftRefs.push({
                    ref: story.ref,
                    proseRefs: driftDetail.proseRefs,
                    manifestRefs: driftDetail.manifestRefs,
                });
                continue;
            }
            const disciplineResult = activeAdapter.validateAgainstDiscipline(story);
            if ("kind" in disciplineResult && disciplineResult.kind === "discipline-violation") {
                const firstViolation = disciplineResult.violations[0];
                result.skippedRefs.push({
                    ref: story.ref,
                    reason: "discipline-violation",
                    detail: firstViolation?.detail,
                });
                // Write a blocked manifest into blocked/ (Task 6.1).
                const blockedManifestRaw = stripUndefined({
                    ref: story.ref,
                    status: "blocked",
                    adapter: activeAdapterName,
                    source_path: repoRelativePath(story.raw_path, targetRepoRoot),
                    source_hash: story.source_hash,
                    depends_on: story.depends_on,
                    acceptance_criteria: story.acceptance_criteria,
                    title: story.title,
                    narrative: story.narrative,
                    narrative_struct: story.narrative_struct,
                    tasks: story.tasks,
                    cited_sources: story.cited_sources,
                    implementation_notes: story.implementation_notes,
                    withdrawn: false,
                    blocked_by: "planning-discipline",
                    discipline_violations: disciplineResult.violations.map((v) => ({
                        code: v.code,
                        field: v.field,
                        detail: v.detail,
                    })),
                });
                const blockedManifest = ExecutionManifestSchema.parse(blockedManifestRaw);
                const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
                const yamlText = yamlStringify(blockedManifest, { lineWidth: 0 });
                await writeManagedFile({
                    absPath: absBlockedPath,
                    contents: yamlText,
                    targetRepoRoot,
                    mcpToolContext: { toolName: "scanSources", role: "operator" },
                });
                result.blockedRefs.push(story.ref);
                continue;
            }
        }
        // Step 6: Branch on to-do presence.
        const absToDoPath = path.join(stateRoot, "to-do", `${story.ref}.yaml`);
        if (currentState === null) {
            // CREATE path (AC1): no manifest exists anywhere and discipline passed.
            const manifest = composeManifest(story, activeAdapterName, targetRepoRoot);
            const yamlText = yamlStringify(manifest, { lineWidth: 0 });
            await writeManagedFile({
                absPath: absToDoPath,
                contents: yamlText,
                targetRepoRoot,
                mcpToolContext: { toolName: "scanSources", role: "operator" },
            });
            result.createdRefs.push(story.ref);
        }
        else if (currentState === "to-do") {
            // UPDATE or UNCHANGED path (AC2/AC3): manifest is in to-do/.
            // Story 5.19: wrap readFile in try/catch — on read failure (corrupt FS,
            // permissions, transient IO), skip this single manifest with
            // reason: "unreadable-manifest" and detail: "<errno>: <path>" so the
            // scan continues with the remaining manifests instead of aborting.
            let rawText;
            try {
                rawText = await fs.readFile(absToDoPath, "utf8");
            }
            catch (err) {
                const errno = err.code ?? "UNKNOWN";
                result.skippedRefs.push({
                    ref: story.ref,
                    reason: "unreadable-manifest",
                    detail: `${errno}: ${absToDoPath}`,
                });
                continue;
            }
            let existingManifest;
            try {
                const parsed = yamlParse(rawText);
                existingManifest = parseExecutionManifest(parsed, { absPath: absToDoPath });
            }
            catch (err) {
                // Story 5.19: malformed YAML / schema parse failures are per-file
                // recoverable signals — push to skippedRefs with reason: "unreadable-manifest"
                // and detail derived from the error, then continue. (Previously this
                // path propagated MalformedExecutionManifestError to the boundary,
                // aborting the entire scan on the first bad file.)
                const detailMessage = err instanceof Error ? err.message : String(err);
                result.skippedRefs.push({
                    ref: story.ref,
                    reason: "unreadable-manifest",
                    detail: `parse-error: ${detailMessage}`,
                });
                continue;
            }
            if (existingManifest.source_hash !== story.source_hash) {
                // Story 5.16: deps-drift gate on to-do refresh — mirrors blocked-branch (line 404)
                // and currentState === null (line 496). Without this, an operator edit that
                // introduces a new prose dep AFTER first scan would silently absorb into the
                // refreshed to-do manifest.
                const driftDetail = await checkDepsDrift(story);
                if (driftDetail !== null) {
                    const absBlockedPath = path.join(stateRoot, "blocked", `${story.ref}.yaml`);
                    await writeDepsDriftBlockedManifest(story, driftDetail, absBlockedPath, activeAdapterName, targetRepoRoot);
                    result.skippedRefs.push({
                        ref: story.ref,
                        reason: "discipline-violation",
                        detail: `deps-drift-prose-vs-manifest: prose: [${driftDetail.proseRefs.join(", ")}], manifest: [${driftDetail.manifestRefs.join(", ")}]`,
                    });
                    result.blockedRefs.push(story.ref);
                    result.depsDriftRefs.push({
                        ref: story.ref,
                        proseRefs: driftDetail.proseRefs,
                        manifestRefs: driftDetail.manifestRefs,
                    });
                    continue;
                }
                // No drift — existing rewrite path follows unchanged.
                // Hash changed → rewrite with new hash and source_path; preserve all other fields.
                // Operator hand-edits to narrative, acceptance_criteria, withdrawn etc. are preserved
                // per Story 3.7's hand-edit allowance.
                const updatedManifest = {
                    ...existingManifest,
                    source_hash: story.source_hash,
                    source_path: repoRelativePath(story.raw_path, targetRepoRoot),
                };
                const yamlText = yamlStringify(stripUndefined(updatedManifest), {
                    lineWidth: 0,
                });
                await writeManagedFile({
                    absPath: absToDoPath,
                    contents: yamlText,
                    targetRepoRoot,
                    mcpToolContext: { toolName: "scanSources", role: "operator" },
                });
                result.updatedRefs.push(story.ref);
            }
            else {
                // Hash matches → no-op (AC2 idempotency).
                result.unchangedRefs.push(story.ref);
            }
        }
        // Note: the else branch for currentState not null and not "to-do" is handled
        // in Step 4 above (before discipline check) — those refs are already skipped.
    }
    return result;
}
