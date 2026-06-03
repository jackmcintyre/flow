import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { validateStoryAgainstDiscipline } from "../../validators/planning-discipline.js";
import { parseNativeStory } from "./parse-native-story.js";
/**
 * Native planning adapter — v1 implementation (Story 3.4).
 *
 * The adapter normalises native-story files under
 * `<targetRepo>/.flow/native-stories/` into the canonical `SourceStory`
 * shape defined by Story 3.1's `PlanningAdapter` interface.
 *
 * Filename pattern: `^[0-9A-HJKMNP-TV-Z]{26}\.md$` (ULID per Crockford
 * base32 alphabet). Files not matching are silently skipped.
 *
 * `detect()` is stateless: it answers against an explicit `targetRepo`
 * argument. The other interface methods require a bound context set via
 * {@link configureNativeAdapter}, called by `resolveWorkspace` once the
 * workspace config has been resolved. Tests call `configureNativeAdapter`
 * directly.
 *
 * @see _bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md § Task 1
 */
/** Crockford base32 ULID filename pattern. */
const NATIVE_FILENAME_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.md$/;
const NATIVE_STORIES_SUBDIR = path.join(".flow", "native-stories");
let currentContext;
/**
 * Configure the bound `targetRepo` context the adapter's list/read/resolve
 * methods operate against. Called by `resolveWorkspace` (via the adapter
 * branch in workspace-resolver.ts) and by tests.
 */
export function configureNativeAdapter(ctx) {
    currentContext = { targetRepo: path.resolve(ctx.targetRepo) };
}
/** Reset the bound context — primarily for test cleanup. */
export function resetNativeAdapter() {
    currentContext = undefined;
}
function requireContext() {
    if (!currentContext) {
        throw new Error("NativeAdapter has no bound context. Call configureNativeAdapter({ targetRepo }) " +
            "before invoking list/read/resolve. (Story 3.4)");
    }
    return currentContext;
}
function nativeStoriesDir(targetRepo) {
    return path.join(targetRepo, NATIVE_STORIES_SUBDIR);
}
async function listNativeStoryFiles(storiesDir) {
    let entries;
    try {
        entries = await fs.readdir(storiesDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (e.isFile() && NATIVE_FILENAME_RE.test(e.name)) {
            out.push(path.join(storiesDir, e.name));
        }
        // No subdirectory recursion per spec Task 1.6.
    }
    return out;
}
function parseRef(ref) {
    const m = /^native:([0-9A-HJKMNP-TV-Z]{26})$/.exec(ref);
    if (!m)
        return null;
    return { ulid: m[1] };
}
export const NativeAdapter = {
    name: "native",
    /**
     * Returns `true` iff `<targetRepo>/.flow/native-stories/` exists AND
     * contains at least one ULID-named `.md` file. Permission errors → `false`.
     */
    async detect(targetRepo) {
        const storiesDir = nativeStoriesDir(targetRepo);
        try {
            const stat = await fs.stat(storiesDir);
            if (!stat.isDirectory())
                return false;
        }
        catch {
            return false;
        }
        try {
            const entries = await fs.readdir(storiesDir);
            return entries.some((name) => NATIVE_FILENAME_RE.test(name));
        }
        catch {
            return false;
        }
    },
    async listSourceStories() {
        const ctx = requireContext();
        const storiesDir = nativeStoriesDir(ctx.targetRepo);
        const files = await listNativeStoryFiles(storiesDir);
        const results = [];
        for (const file of files) {
            const contents = await fs.readFile(file, "utf8");
            // Per-file parse resilience (Story 10.3): a single malformed native file
            // must NOT abort the whole scan — that would be a live-backlog outage (one
            // bad file taking down the entire backlog projection). The native parser
            // already fail-closes on the structural Tier-0 shapes (an AC with no
            // verification directive, a task with no/dangling AC ref, an empty Cited
            // Sources section); a story carrying one of those is structurally
            // un-parseable and therefore correctly absent from to-do/ (fail-closed).
            // We log a loud warning (NOT a silent skip — see the project's "native
            // scan silently skips" anti-pattern) and continue with the good files.
            try {
                results.push(parseNativeStory(file, contents));
            }
            catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                console.warn(`[NativeAdapter] Skipping malformed native story '${file}' — it failed to parse and is fail-closed (NOT projected to to-do/). Fix the source and re-run /flow:scan. Reason: ${reason}`);
            }
        }
        // Sort by ULID (lexicographic = chronological for ULIDs).
        results.sort((a, b) => a.ref.localeCompare(b.ref));
        return results;
    },
    async readSourceStory(ref) {
        const ctx = requireContext();
        const parsed = parseRef(ref);
        if (!parsed) {
            throw new Error(`NativeAdapter.readSourceStory: ref '${ref}' is not a valid native ref ` +
                `(expected 'native:<26-char ULID>'). (Story 3.4)`);
        }
        const absPath = path.join(nativeStoriesDir(ctx.targetRepo), `${parsed.ulid}.md`);
        let contents;
        try {
            contents = await fs.readFile(absPath, "utf8");
        }
        catch {
            throw new Error(`NativeAdapter.readSourceStory: file not found for ref '${ref}' at '${absPath}'. (Story 3.4)`);
        }
        return parseNativeStory(absPath, contents);
    },
    /**
     * Pure function — parse the ULID out of the ref and return the absolute
     * path. No I/O.
     */
    resolveSourcePath(ref) {
        const ctx = requireContext();
        const parsed = parseRef(ref);
        if (!parsed) {
            throw new Error(`NativeAdapter.resolveSourcePath: ref '${ref}' is not a valid native ref. (Story 3.4)`);
        }
        return path.join(nativeStoriesDir(ctx.targetRepo), `${parsed.ulid}.md`);
    },
    /** Native adapter has no per-repo config in v1. */
    defaultConfig() {
        return {};
    },
    /** Reject unknown keys; accept empty object. */
    adapterConfigSchema: z.object({}).strict(),
    /**
     * Validate a native `SourceStory` against planning-discipline rules.
     * Delegates to the pure `validateStoryAgainstDiscipline` function (Story 3.5).
     *
     * Per-story only — ship-gate (backlog-level) is enforced by `validatePlannerBacklog`.
     *
     * @see _bmad-output/implementation-artifacts/3-5-planning-discipline-validation-at-authoring-and-scan-time.md § Task 2
     */
    validateAgainstDiscipline(story) {
        return validateStoryAgainstDiscipline(story);
    },
};
export { parseNativeStory };
