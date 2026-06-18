/**
 * `captureSkillInvoke` — the deterministic capture seam for `skill.invoke`
 * telemetry. Story native:01KV4610DTPJJR5E5JJN7P235D (finishes Story 6.8's
 * deferred capture-trigger AC).
 *
 * Story 6.8 shipped the `recordSkillInvoke` write-path and the
 * `computeSkillEffectiveness` scorer, but the only capture trigger that ever
 * landed was a FRAGILE prose-call in `/flow:board`'s SKILL.md first step — one
 * skill, and "MUST-call-X" prose seams get skipped under load (the standing
 * project lesson). This seam replaces that with a DETERMINISTIC plugin
 * `PreToolUse` hook on the `Skill` tool: it fires for every programmatic skill
 * invocation and funnels a single `skill.invoke` event through the canonical
 * `recordSkillInvoke` write-path.
 *
 * Receives the raw Claude Code `PreToolUse` hook payload (the JSON the harness
 * pipes to a `command` hook on stdin).
 *
 * FAIL-SOFT (AC3): this function NEVER throws. Any malformed payload, missing
 * field, or downstream error returns `{ recorded: false, reason }`; the hook
 * script always exits 0, so a telemetry hiccup can never block a skill call.
 *
 * SEAM (live-spike grounded): in this Claude Code build the skill name arrives
 * at `tool_input.skill` (NOT `tool_input.name`). The `Skill` tool is the path
 * the harness uses for PROGRAMMATIC / agent skill invocations; user-typed slash
 * commands expand via a different path (`UserPromptExpansion`), so everything
 * reaching THIS seam is `agent-call`. Capturing user-typed invocations is a
 * documented follow-up.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { parse as yamlParse } from "yaml";
import { recordSkillInvoke } from "./record-skill-invoke.js";

export interface CaptureSkillInvokeResult {
  recorded: boolean;
  reason?: string;
}

interface SkillMeta {
  skillPath: string;
  skillVersion: string;
  skillScope: "project" | "persona" | "plugin";
}

/**
 * Test/DI seams so the derivation is deterministic without touching the real
 * filesystem, clock, or env (mirrors the codebase's injected-seam discipline).
 */
export interface CaptureSkillInvokeDeps {
  recordImpl?: typeof recordSkillInvoke;
  readFileImpl?: (filePath: string) => Promise<string>;
  pluginRoot?: string;
  /**
   * Test seam: inject the list of `.flow/state/in-progress/` directory entries
   * so the active-story-ref derivation is deterministic without touching disk.
   * Production callers omit this (the real `fs.readdir` is used).
   */
  readInProgressDirImpl?: (dirPath: string) => Promise<string[]>;
}

/**
 * Best-effort read of the plugin's single overall version from its manifest
 * (`<pluginRoot>/.claude-plugin/plugin.json`). Used as the fallback skill
 * version for skills whose own SKILL.md declares no `version:` line — which is
 * MOST skills, so without this fallback most `skill.invoke` events recorded a
 * meaningless "unknown". NEVER throws — any miss returns "unknown".
 */
async function resolvePluginVersion(
  pluginRoot: string,
  readFileImpl: (filePath: string) => Promise<string>,
): Promise<string> {
  try {
    const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    const raw = await readFileImpl(manifestPath);
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through to "unknown"
  }
  return "unknown";
}

/**
 * Best-effort resolve a skill's file path + version from the plugin root the
 * hook runs under (`CLAUDE_PLUGIN_ROOT`). A skill that declares its own
 * `version:` line keeps that declared version (passthrough); a skill with no
 * version line of its own falls back to the plugin's overall manifest version
 * rather than recording "unknown" (most skills carry no version line). NEVER
 * throws — on any miss it returns safe, schema-valid defaults (the
 * `skill_version`/`skill_path` fields are not the join key for effectiveness
 * scoring; `skill_name` is).
 */
async function resolveSkillMeta(
  skillName: string,
  pluginRoot: string | undefined,
  readFileImpl: (filePath: string) => Promise<string>,
): Promise<SkillMeta> {
  // Skill names are "<plugin>:<command>" (e.g. flow:board) or a bare command.
  const command = skillName.includes(":")
    ? skillName.slice(skillName.indexOf(":") + 1)
    : skillName;
  if (pluginRoot && command) {
    const skillPath = path.join(pluginRoot, "skills", command, "SKILL.md");
    try {
      const raw = await readFileImpl(skillPath);
      const match = raw.match(/^version:\s*(.+?)\s*$/m);
      if (match && match[1]) {
        // The skill declares its own version — keep it untouched.
        return { skillPath, skillVersion: match[1].trim(), skillScope: "plugin" };
      }
      // No version line of its own — fall back to the plugin's overall version.
      const skillVersion = await resolvePluginVersion(pluginRoot, readFileImpl);
      return { skillPath, skillVersion, skillScope: "plugin" };
    } catch {
      // Skill file unreadable — still prefer the plugin-version fallback over "unknown".
      const skillVersion = await resolvePluginVersion(pluginRoot, readFileImpl);
      return { skillPath, skillVersion, skillScope: "plugin" };
    }
  }
  return { skillPath: skillName, skillVersion: "unknown", skillScope: "plugin" };
}

/**
 * Best-effort resolve the story `ref` that a skill invocation belongs to, so the
 * recorded `skill.invoke` carries a `story_id` the effectiveness scorer can join
 * to a downstream `reviewer.verdict` (which stamps `story_id = resultFile.ref`).
 *
 * ### Why this is the join key (issue #390)
 * The `skill.invoke` envelope `session_id` is the Claude Code HARNESS session id
 * of whichever (sub)agent fired the skill; the `reviewer.verdict` `session_id`
 * is the run-minted ULID (`mintSessionUlid`) the orchestrator stamps in
 * `postReviewerComments`. Those two ids come from different namespaces and can
 * NEVER match, so the original `session_id`-only join produced
 * `useful_fire_count: 0` for every skill. The story `ref` is the one identifier
 * BOTH sides can carry: the verdict already has it; this seam puts it on the
 * invoke side.
 *
 * ### How the ref is determined (and the concurrency guard)
 * A story under active build has a manifest in
 * `<targetRepoRoot>/.flow/state/in-progress/<ref>.yaml`. When EXACTLY ONE such
 * manifest exists, that story's `ref` is unambiguously the active flow and is
 * returned. When ZERO are in progress (an operator-session skill outside any
 * flow) or MORE THAN ONE are in progress (concurrent builds — a naive read can't
 * tell which flow this skill belongs to), this returns `undefined` and the
 * invoke is recorded WITHOUT a `story_id`. That is the conservative choice: a
 * wrong attribution would corrupt the metric, whereas a missing one merely falls
 * back to the (harmless) session-only join. The project's recommended serial
 * mode (`maxConcurrency: 1`) is the single-in-progress case, so attribution
 * fires for the common path.
 *
 * NEVER throws — any read/parse failure returns `undefined` (fail-soft; the
 * capture seam's AC3 contract must hold).
 */
async function resolveActiveStoryRef(
  targetRepoRoot: string,
  readInProgressDirImpl:
    | ((dirPath: string) => Promise<string[]>)
    | undefined,
  readFileImpl: (filePath: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    const inProgressDir = path.join(
      targetRepoRoot,
      ".flow",
      "state",
      "in-progress",
    );
    const entries = readInProgressDirImpl
      ? await readInProgressDirImpl(inProgressDir)
      : await fs.readdir(inProgressDir);

    // Full execution manifests only — exclude the `<ref>.snapshot.yaml` claim
    // baselines (they are not manifests and carry no authoritative ref/status).
    const manifestFiles = entries.filter(
      (f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"),
    );

    const inProgressRefs: string[] = [];
    for (const file of manifestFiles) {
      let parsed: unknown;
      try {
        const raw = await readFileImpl(path.join(inProgressDir, file));
        parsed = yamlParse(raw);
      } catch {
        continue; // unreadable/unparseable manifest — skip, never fatal
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).status === "in-progress" &&
        typeof (parsed as Record<string, unknown>).ref === "string" &&
        ((parsed as Record<string, unknown>).ref as string).length > 0
      ) {
        inProgressRefs.push((parsed as Record<string, unknown>).ref as string);
      }
    }

    // Attribute ONLY when exactly one story is in progress (unambiguous).
    return inProgressRefs.length === 1 ? inProgressRefs[0] : undefined;
  } catch {
    // Dir absent (no flow running) or any other error → no attribution.
    return undefined;
  }
}

/**
 * Derive a `skill.invoke` event from a raw `PreToolUse` hook payload and record
 * it through the canonical write-path. Returns `{ recorded }` — never throws.
 */
export async function captureSkillInvoke(
  rawHookPayload: unknown,
  deps: CaptureSkillInvokeDeps = {},
): Promise<CaptureSkillInvokeResult> {
  const recordImpl = deps.recordImpl ?? recordSkillInvoke;
  const readFileImpl =
    deps.readFileImpl ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  const pluginRoot = deps.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT;

  try {
    if (typeof rawHookPayload !== "object" || rawHookPayload === null) {
      return { recorded: false, reason: "payload-not-an-object" };
    }
    const payload = rawHookPayload as Record<string, unknown>;
    if (payload.tool_name !== "Skill") {
      return { recorded: false, reason: "not-a-skill-tool-call" };
    }

    // The live spike confirmed the skill name lives at tool_input.skill in this
    // build — NOT tool_input.name (the original draft's refuted assumption).
    const toolInput = payload.tool_input;
    const skillName =
      typeof toolInput === "object" && toolInput !== null
        ? (toolInput as Record<string, unknown>).skill
        : undefined;
    if (typeof skillName !== "string" || skillName.length === 0) {
      return { recorded: false, reason: "missing-skill-name" };
    }

    const targetRepoRoot =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd();
    const sessionUlid =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : "unknown-session";

    const meta = await resolveSkillMeta(skillName, pluginRoot, readFileImpl);

    // Resolve the active story flow's ref so the recorded invoke carries a
    // `story_id` the effectiveness scorer can join to the reviewer verdict
    // (issue #390). Fail-soft: an unresolvable/ambiguous flow → no story_id.
    const storyId = await resolveActiveStoryRef(
      targetRepoRoot,
      deps.readInProgressDirImpl,
      readFileImpl,
    );

    await recordImpl({
      targetRepoRoot,
      sessionUlid,
      agent: "agent",
      ...(storyId !== undefined ? { storyId } : {}),
      data: {
        skill_name: skillName,
        skill_path: meta.skillPath,
        skill_version: meta.skillVersion,
        skill_scope: meta.skillScope,
        invocation_source: "agent-call",
      },
    });
    return { recorded: true };
  } catch (err) {
    // FAIL-SOFT: a telemetry failure must never block a skill call (AC3).
    return { recorded: false, reason: (err as Error).message || "unknown-error" };
  }
}
