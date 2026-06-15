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
}

/**
 * Best-effort resolve a skill's file path + frontmatter `version:` from the
 * plugin root the hook runs under (`CLAUDE_PLUGIN_ROOT`). NEVER throws — on any
 * miss it returns safe, schema-valid defaults (the `skill_version`/`skill_path`
 * fields are not the join key for effectiveness scoring; `skill_name` is).
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
      const skillVersion = match && match[1] ? match[1].trim() : "unknown";
      return { skillPath, skillVersion, skillScope: "plugin" };
    } catch {
      // fall through to defaults
    }
  }
  return { skillPath: skillName, skillVersion: "unknown", skillScope: "plugin" };
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

    await recordImpl({
      targetRepoRoot,
      sessionUlid,
      agent: "agent",
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
