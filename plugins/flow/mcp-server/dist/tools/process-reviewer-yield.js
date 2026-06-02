/**
 * `processReviewerYield` MCP tool — Story 4.11 Task 4.
 *
 * Composes `yield-parser` + `lookupRoleByDomain` (FR99) + `buildPersonaSpawnPrompt`
 * + `logTelemetryEvent` into a single deterministic seam. The SKILL.md prose
 * (in the future wiring story) calls this BEFORE `postReviewerComments` /
 * `processReviewerTranscript` when the reviewer Task returns.
 *
 * Returns a discriminated `next:` value:
 *  - `"no-yield"` — the common path; pass through to the existing flow.
 *  - `"spawn-specialist-reviewer"` — FR100 success branch; caller spawns the specialist.
 *  - `"done-blocked-routing-failure"` — FR100 failure branch; no hired role matched.
 *  - `"done-blocked-routing-self-yield"` — AC2c guard; specialist tried to yield to its own domain.
 *
 * **Chain-depth cap (v1 = 1):**
 * This tool is called by SKILL.md prose AFTER the *generalist* reviewer's Task
 * returns. The wiring story (not this story) is responsible for NOT calling
 * `processReviewerYield` after a *specialist* reviewer Task — i.e. a specialist's
 * transcript is never re-parsed for yields. The `fromRole` parameter carries the
 * role that just ran; the self-yield guard (step v) catches the trivial loop.
 * Multi-specialist chain support is deferred.
 *
 * **Telemetry:**
 * A `yield.handoff` event is emitted ONLY on the success branch (FR103, NFR29).
 * Telemetry failure is non-fatal — the spawn prompt is returned regardless.
 *
 * **Manifest stamp:**
 * Failure branches write `blocked_by: "routing-failure"` or `blocked_by:
 * "routing-self-yield"` to the in-progress manifest. Atomic write via
 * `writeManifest` (Story 1.6's primitive).
 *
 * Story 4.11 Task 4.1–4.5. References: FR99, FR100, FR101, FR102, FR103, FR104, NFR29.
 */
import { parseYield } from "../skills/yield-parser.js";
import { lookupRoleByDomain } from "./lookup-role-by-domain.js";
import { buildPersonaSpawnPrompt } from "./build-persona-spawn-prompt.js";
import { readManifest, writeManifest } from "../lib/manifest-io.js";
import { logTelemetryEvent } from "../lib/logger.js";
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/**
 * Process the reviewer subagent's transcript for a yield phrase, and route
 * the review to the appropriate specialist if one is found.
 *
 * Algorithm (AC1 unpacked, 1e):
 *  (i)   Call `parseYield` on the reviewer's transcript.
 *  (ii)  If `ok: false`, return `no-yield` (chatLog empty — common path is silent).
 *  (iii) If `ok: true`, call `lookupRoleByDomain({ targetRepoRoot, domain })`.
 *  (iv)  If `role === null`, stamp manifest `blocked_by: "routing-failure"` and
 *        return `done-blocked-routing-failure`.
 *  (v)   If `role === fromRole` (self-yield: specialist named its own domain),
 *        stamp `blocked_by: "routing-self-yield"` and return the guard response.
 *  (vi)  Else call `buildPersonaSpawnPrompt({ targetRepoRoot, role })`, emit
 *        `yield.handoff` telemetry, return `spawn-specialist-reviewer`.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling session.
 * @param opts.ref - Story ref (e.g. `"native:01HZ..."`).
 * @param opts.fromRole - Role that just ran (kebab-case, e.g. `"generalist-reviewer"`).
 * @param opts.reviewerTranscript - The reviewer subagent's complete final message, verbatim.
 * @param opts.manifestPath - Absolute path to the in-progress manifest YAML.
 */
export async function processReviewerYield(opts) {
    const { targetRepoRoot, sessionUlid, ref, fromRole, reviewerTranscript, manifestPath } = opts;
    // ---------------------------------------------------------------------------
    // Step (i): Parse the yield phrase.
    // ---------------------------------------------------------------------------
    const parseResult = parseYield(reviewerTranscript);
    // ---------------------------------------------------------------------------
    // Step (ii): No yield — common path. Return silently (chatLog empty).
    // ---------------------------------------------------------------------------
    if (!parseResult.ok) {
        return { next: "no-yield", chatLog: [] };
    }
    const { domain } = parseResult;
    // ---------------------------------------------------------------------------
    // Step (iii): Look up the role by domain.
    // ---------------------------------------------------------------------------
    const lookupResult = await lookupRoleByDomain({ targetRepoRoot, domain });
    // ---------------------------------------------------------------------------
    // Step (iv): No hired role matches — routing failure.
    // ---------------------------------------------------------------------------
    if (lookupResult.role === null) {
        // Stamp the manifest with blocked_by: routing-failure.
        const currentManifest = await readManifest(manifestPath);
        await writeManifest(manifestPath, {
            ...currentManifest,
            blocked_by: "routing-failure",
        });
        const chatLog = [
            `[routing-failure] no hired role matches domain "${domain}" — story ${ref} blocked. Clear blocked_by on the manifest and re-run /flow:start after hiring a role with this domain.`,
        ];
        return { next: "done-blocked-routing-failure", chatLog };
    }
    const toRole = lookupResult.role;
    // ---------------------------------------------------------------------------
    // Step (v): Self-yield guard (AC2c).
    // If the resolved role is the same as the role that just ran, the specialist
    // is trying to yield to its own domain. Reject as a self-yield.
    // ---------------------------------------------------------------------------
    if (toRole === fromRole) {
        // Stamp the manifest with blocked_by: routing-self-yield.
        const currentManifest = await readManifest(manifestPath);
        await writeManifest(manifestPath, {
            ...currentManifest,
            blocked_by: "routing-self-yield",
        });
        const chatLog = [
            `[routing-failure] self-yield rejected — ${fromRole} attempted to yield to its own domain "${domain}"; in-domain insistence applies`,
        ];
        return { next: "done-blocked-routing-self-yield", chatLog };
    }
    // ---------------------------------------------------------------------------
    // Step (vi): Success path — build spawn prompt and emit telemetry.
    // ---------------------------------------------------------------------------
    // buildPersonaSpawnPrompt will throw PersonaFileNotFoundError if the persona
    // file was deleted between lookupRoleByDomain and here (race condition).
    // We propagate the error verbatim per AC1h.
    const { systemPrompt: specialistPrompt } = await buildPersonaSpawnPrompt({
        targetRepoRoot,
        role: toRole,
    });
    // Emit the yield.handoff telemetry event (AC4b).
    // Wrapped in try/catch — a telemetry-write failure MUST NOT prevent the
    // spawn-prompt from being returned to the caller (AC4b).
    try {
        await logTelemetryEvent({
            targetRepoRoot,
            event: {
                type: "yield.handoff",
                session_id: sessionUlid,
                agent: fromRole,
                story_id: ref,
                data: {
                    from_role: fromRole,
                    to_role: toRole,
                    domain,
                },
            },
        });
    }
    catch {
        // Telemetry failure is non-fatal. The existing telemetry.invalid fallback
        // path (Story 1.5) records the failure in the JSONL. Continue.
    }
    const chatLog = [
        `yield routed — from ${fromRole} to ${toRole} on domain "${domain}" — spawning specialist reviewer (clean context)`,
    ];
    return {
        next: "spawn-specialist-reviewer",
        toRole,
        specialistPrompt,
        chatLog,
    };
}
