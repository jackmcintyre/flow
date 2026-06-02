/**
 * Integration tests for `recordSkillInvoke` — Story 6.8 AC1 + AC4.
 *
 * AC1: a `recordSkillInvoke` call emits exactly one well-formed `skill.invoke`
 *      line with all five `data` fields; the schema rejects an unknown
 *      `skill_scope` / `invocation_source` (closed enums, no fallback).
 * AC4: the capture seam wired into the `/flow:board` SKILL.md first-step is
 *      verified — the chosen mechanism (a prose-call seam on the fallback path,
 *      because the harness exposes no skill-invocation hook) is exercised here:
 *      the test reproduces exactly what the instrumented SKILL.md does (mint a
 *      session id, call `recordSkillInvoke` with the skill's frontmatter
 *      `skill_version` and the `plugin` / `user-slash-command` scope+source)
 *      and asserts a valid `skill.invoke` event lands. The under-count
 *      limitation of a prose-call seam is documented in the source story.
 *
 * Telemetry is read back from the real `.flow/telemetry/<YYYY-MM>.jsonl` file
 * the logger writes — we drive a fixed clock so the month bucket is stable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordSkillInvoke } from "../record-skill-invoke.js";
import { mintSessionUlid } from "../mint-session-ulid.js";
import { MalformedSkillInvokeInputError } from "../../errors.js";
import {
  SkillInvokeEventSchema,
  TelemetryEventSchema,
} from "../../schemas/telemetry-events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fixed clock so the logger's month bucket is deterministic. */
const FIXED_NOW = () => new Date("2026-05-31T12:00:00.000Z");
const MONTH_FILE = "2026-05.jsonl";

/** Read every parsed event from the telemetry dir for the fixed month. */
async function readTelemetryEvents(targetRepoRoot: string): Promise<unknown[]> {
  const filePath = path.join(targetRepoRoot, ".flow", "telemetry", MONTH_FILE);
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

const VALID_DATA = {
  skill_name: "flow:plan",
  skill_path: "/abs/plugins/flow/skills/plan/SKILL.md",
  skill_version: "0.1.0",
  skill_scope: "plugin" as const,
  invocation_source: "user-slash-command" as const,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "record-skill-invoke-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — single well-formed write + closed-enum rejection
// ---------------------------------------------------------------------------

describe("recordSkillInvoke — AC1 write path", () => {
  it("emits exactly one well-formed skill.invoke line with all five data fields", async () => {
    const result = await recordSkillInvoke({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HZSESSION0000000000000001",
      agent: "user",
      storyId: "bmad:6.8",
      data: VALID_DATA,
      now: FIXED_NOW,
    });
    expect(result).toEqual({ recorded: true });

    const events = await readTelemetryEvents(tmpRoot);
    // EXACTLY ONE line.
    expect(events).toHaveLength(1);

    const event = events[0];
    // Well-formed against the canonical union schema.
    const parsed = TelemetryEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);

    const skillEvent = SkillInvokeEventSchema.parse(event);
    expect(skillEvent.type).toBe("skill.invoke");
    expect(skillEvent.session_id).toBe("01HZSESSION0000000000000001");
    expect(skillEvent.agent).toBe("user");
    expect(skillEvent.story_id).toBe("bmad:6.8");
    // ts is stamped by the logger.
    expect(skillEvent.ts).toBe("2026-05-31T12:00:00.000Z");

    // All FIVE data fields present + correct.
    expect(skillEvent.data).toEqual({
      skill_name: "flow:plan",
      skill_path: "/abs/plugins/flow/skills/plan/SKILL.md",
      skill_version: "0.1.0",
      skill_scope: "plugin",
      invocation_source: "user-slash-command",
    });
  });

  it("omits story_id from the event when not supplied (user-slash-command outside a story)", async () => {
    await recordSkillInvoke({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HZSESSION0000000000000002",
      agent: "user",
      data: VALID_DATA,
      now: FIXED_NOW,
    });

    const events = await readTelemetryEvents(tmpRoot);
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).story_id).toBeUndefined();
  });

  it("rejects an unknown skill_scope (closed enum, no fallback) and writes no event", async () => {
    await expect(
      recordSkillInvoke({
        targetRepoRoot: tmpRoot,
        sessionUlid: "01HZSESSION0000000000000003",
        agent: "user",
        data: { ...VALID_DATA, skill_scope: "global" },
        now: FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(MalformedSkillInvokeInputError);

    // No skill.invoke event (and no telemetry file at all) was written.
    const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
    await expect(fs.readdir(telemetryDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unknown invocation_source (closed enum, no fallback)", async () => {
    await expect(
      recordSkillInvoke({
        targetRepoRoot: tmpRoot,
        sessionUlid: "01HZSESSION0000000000000004",
        agent: "user",
        data: { ...VALID_DATA, invocation_source: "cron" },
        now: FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(MalformedSkillInvokeInputError);
  });

  it("rejects a missing required data field", async () => {
    const { skill_version: _omitted, ...withoutVersion } = VALID_DATA;
    await expect(
      recordSkillInvoke({
        targetRepoRoot: tmpRoot,
        sessionUlid: "01HZSESSION0000000000000005",
        agent: "user",
        data: withoutVersion,
        now: FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(MalformedSkillInvokeInputError);
  });

  it("rejects an unknown extra data key (.strict())", async () => {
    await expect(
      recordSkillInvoke({
        targetRepoRoot: tmpRoot,
        sessionUlid: "01HZSESSION0000000000000006",
        agent: "user",
        data: { ...VALID_DATA, surprise: "key" },
        now: FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(MalformedSkillInvokeInputError);
  });
});

// ---------------------------------------------------------------------------
// AC4 — capture seam exercised end-to-end for the /flow:board skill
// ---------------------------------------------------------------------------

describe("recordSkillInvoke — AC4 capture seam (/flow:board, fallback prose-call path)", () => {
  it("reproduces the instrumented SKILL.md first-step and lands a valid skill.invoke event", async () => {
    // Mechanism (verified for this harness): the plugin manifest exposes no
    // skill-invocation hook, so the seam is a prose-call in the SKILL.md first
    // step (the shipped recordYield / recordStoryRetro precedent). This test
    // reproduces exactly what that first step does.

    // 1. The skill mints a session id (mintSessionUlid).
    const { sessionUlid } = mintSessionUlid();
    expect(sessionUlid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // 2. The skill calls recordSkillInvoke with the board skill's frontmatter
    //    version (0.1.0) and the plugin / user-slash-command scope+source.
    const result = await recordSkillInvoke({
      targetRepoRoot: tmpRoot,
      sessionUlid,
      agent: "user",
      data: {
        skill_name: "flow:board",
        skill_path: "/abs/plugins/flow/skills/board/SKILL.md",
        skill_version: "0.1.0",
        skill_scope: "plugin",
        invocation_source: "user-slash-command",
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ recorded: true });

    // 3. A valid skill.invoke event landed with the correct fields.
    const events = await readTelemetryEvents(tmpRoot);
    expect(events).toHaveLength(1);
    const event = SkillInvokeEventSchema.parse(events[0]);
    expect(event.data.skill_name).toBe("flow:board");
    expect(event.data.skill_version).toBe("0.1.0");
    expect(event.data.skill_scope).toBe("plugin");
    expect(event.data.invocation_source).toBe("user-slash-command");
    expect(event.session_id).toBe(sessionUlid);
  });

  it("the shipped /flow:board SKILL.md declares the seam tools and a skill_version", async () => {
    // Asserts the wiring is actually present in the shipped skill file — the
    // seam is only real if the SKILL.md lists the tools and carries the
    // version the event reports. (The frontmatter is the source of truth for
    // skill_version on the fallback path.)
    const skillPath = path.resolve(
      __dirname,
      "../../../../skills/board/SKILL.md",
    );
    const raw = await fs.readFile(skillPath, "utf8");
    expect(raw).toMatch(/allowed_tools:.*recordSkillInvoke/);
    expect(raw).toMatch(/allowed_tools:.*mintSessionUlid/);
    expect(raw).toMatch(/^version:\s*0\.1\.0\s*$/m);
    // The first-step prose actually names the tool + the closed-enum values.
    expect(raw).toContain("recordSkillInvoke");
    expect(raw).toContain('skill_scope: "plugin"');
    expect(raw).toContain('invocation_source: "user-slash-command"');
  });
});
