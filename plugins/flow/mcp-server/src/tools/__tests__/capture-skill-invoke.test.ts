/**
 * Tests for `captureSkillInvoke` — the deterministic skill.invoke capture seam.
 * Story native:01KV4610DTPJJR5E5JJN7P235D (finishes Story 6.8's deferred
 * capture-trigger AC).
 *
 * AC2 — the record carries exactly the skill name from `tool_input.skill`
 *       (not a default, not blank, not the wrong field). The wrong-field trap
 *       that sank the original draft (assuming `tool_input.name`) is pinned.
 * AC3 — a malformed payload or a downstream error never throws; the capture is
 *       best-effort and the hook script always exits cleanly so a skill call is
 *       never blocked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { captureSkillInvoke } from "../capture-skill-invoke.js";
import { recordSkillInvoke } from "../record-skill-invoke.js";
import { SkillInvokeEventSchema } from "../../schemas/telemetry-events.js";

const FIXED_NOW = () => new Date("2026-05-31T12:00:00.000Z");
const MONTH_FILE = "2026-05.jsonl";

async function readTelemetryEvents(targetRepoRoot: string): Promise<unknown[]> {
  const filePath = path.join(targetRepoRoot, ".flow", "telemetry", MONTH_FILE);
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

/** A real PreToolUse payload shape for a programmatic skill invocation. */
function skillPayload(
  skill: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Skill",
    tool_input: { skill, args: "some args" },
    session_id: "01HZSESSION0000000000000001",
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-skill-invoke-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC2 — the skill name is read from tool_input.skill, end-to-end
// ---------------------------------------------------------------------------

describe("captureSkillInvoke — AC2 field derivation", () => {
  it("records exactly the skill name from tool_input.skill (real write-path)", async () => {
    const result = await captureSkillInvoke(
      skillPayload("flow:board", { cwd: tmpRoot }),
      {
        // Use the real recorder but pin the clock for a stable month bucket.
        recordImpl: (opts) => recordSkillInvoke({ ...opts, now: FIXED_NOW }),
        // No plugin root → version/path fall back to safe defaults.
        pluginRoot: undefined,
      },
    );
    expect(result).toEqual({ recorded: true });

    const events = await readTelemetryEvents(tmpRoot);
    expect(events).toHaveLength(1);
    const event = SkillInvokeEventSchema.parse(events[0]);
    expect(event.data.skill_name).toBe("flow:board");
    expect(event.data.invocation_source).toBe("agent-call");
    expect(event.data.skill_scope).toBe("plugin");
    expect(event.session_id).toBe("01HZSESSION0000000000000001");
  });

  it("passes the exact skill name through to the recorder (spy)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await captureSkillInvoke(skillPayload("flow:judge"), {
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    expect(result).toEqual({ recorded: true });
    expect(calls).toHaveLength(1);
    const data = (calls[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.skill_name).toBe("flow:judge");
    expect(data.invocation_source).toBe("agent-call");
  });

  it("resolves skill_version from the skill frontmatter when the plugin root is present", async () => {
    const pluginRoot = path.join(tmpRoot, "plugin");
    const expectedPath = path.join(pluginRoot, "skills", "board", "SKILL.md");
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:board"), {
      pluginRoot,
      // Inject the frontmatter rather than touching disk (the canonical-fs
      // guard bans write-shaped fs APIs in tests; the read seam is for this).
      readFileImpl: async (filePath: string) => {
        expect(filePath).toBe(expectedPath);
        return "---\nname: flow:board\nversion: 9.9.9\n---\nbody\n";
      },
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    const data = (calls[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.skill_version).toBe("9.9.9");
    expect(data.skill_path).toBe(expectedPath);
  });

  it("pins the wrong-field trap: tool_input.name is NOT read as the skill name", async () => {
    // The original draft assumed tool_input.name. A payload that carries `name`
    // but not `skill` must record NOTHING — this is the regression guard.
    const calls: unknown[] = [];
    const result = await captureSkillInvoke(
      {
        tool_name: "Skill",
        tool_input: { name: "flow:board" },
        session_id: "s",
      },
      {
        recordImpl: async (opts) => {
          calls.push(opts);
          return { recorded: true as const };
        },
      },
    );
    expect(result).toEqual({ recorded: false, reason: "missing-skill-name" });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 (native:01KV4YGR) — plugin-manifest version fallback for skills that
// declare no version line of their own (the real cause of the live "unknown").
// ---------------------------------------------------------------------------

describe("captureSkillInvoke — plugin-version fallback", () => {
  it("falls back to the plugin manifest version when the skill declares none", async () => {
    const pluginRoot = path.join(tmpRoot, "plugin");
    const skillPath = path.join(pluginRoot, "skills", "status", "SKILL.md");
    const manifestPath = path.join(
      pluginRoot,
      ".claude-plugin",
      "plugin.json",
    );
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:status"), {
      pluginRoot,
      // status-style frontmatter carries NO `version:` line — like most skills.
      readFileImpl: async (filePath: string) => {
        if (filePath === skillPath) {
          return "---\nname: flow:status\ndescription: x\n---\nbody\n";
        }
        if (filePath === manifestPath) {
          return JSON.stringify({ name: "flow", version: "1.2.3" });
        }
        throw new Error(`unexpected read: ${filePath}`);
      },
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    const data = (calls[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.skill_version).toBe("1.2.3");
    expect(data.skill_version).not.toBe("unknown");
    expect(data.skill_path).toBe(skillPath);
  });

  it("keeps a skill's own declared version, unaffected by the fallback (passthrough)", async () => {
    const pluginRoot = path.join(tmpRoot, "plugin");
    const skillPath = path.join(pluginRoot, "skills", "board", "SKILL.md");
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:board"), {
      pluginRoot,
      readFileImpl: async (filePath: string) => {
        if (filePath === skillPath) {
          return "---\nname: flow:board\nversion: 7.7.7\n---\nbody\n";
        }
        // The manifest must NOT be consulted when the skill declares its own
        // version — reading it here would be a fallback-over-reach bug.
        throw new Error(`unexpected read: ${filePath}`);
      },
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    const data = (calls[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.skill_version).toBe("7.7.7");
  });

  it("records 'unknown' fail-soft when neither the skill file nor the manifest is readable", async () => {
    const pluginRoot = path.join(tmpRoot, "plugin");
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:ghost"), {
      pluginRoot,
      readFileImpl: async (filePath: string) => {
        throw new Error(`ENOENT: ${filePath}`);
      },
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    const data = (calls[0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(data.skill_version).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (native:01KV4YGR) — the board view is recorded exactly once: its old
// in-skill prose-call capture is gone, leaving the automatic hook as the sole
// recorder (no double-count relative to every other skill).
// ---------------------------------------------------------------------------

describe("captureSkillInvoke — board view recorded exactly once", () => {
  it("board/SKILL.md no longer carries a prose-call telemetry capture", async () => {
    const skillMd = path.resolve(
      __dirname,
      "../../../../skills/board/SKILL.md",
    );
    const raw = await fs.readFile(skillMd, "utf8");
    // The Story 6.8 prose-call (mint + recordSkillInvoke) is the double-count
    // source; it must be gone now that the deterministic hook records every use.
    expect(raw).not.toContain("recordSkillInvoke");
  });

  it("the deterministic capture funnels exactly one event per single invocation", async () => {
    const result = await captureSkillInvoke(
      skillPayload("flow:board", { cwd: tmpRoot }),
      {
        recordImpl: (opts) => recordSkillInvoke({ ...opts, now: FIXED_NOW }),
        pluginRoot: undefined,
      },
    );
    expect(result).toEqual({ recorded: true });
    const events = await readTelemetryEvents(tmpRoot);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #390 — stamp the active story ref so the effectiveness scorer can join
// the invoke to a downstream reviewer.verdict (which carries the same ref).
// ---------------------------------------------------------------------------

describe("captureSkillInvoke — active story-ref attribution (issue #390)", () => {
  const inProgressDir = "/abs/repo/.flow/state/in-progress";

  it("stamps story_id from the single in-progress manifest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:run", { cwd: "/abs/repo" }), {
      readInProgressDirImpl: async (dir) => {
        expect(dir).toBe(inProgressDir);
        return ["native:01STORYAAA.yaml"];
      },
      readFileImpl: async () =>
        `ref: "native:01STORYAAA"\nstatus: in-progress\nclaimed_by: "run-ulid"\n`,
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.storyId).toBe("native:01STORYAAA");
  });

  it("does NOT stamp story_id when no story is in progress (operator-session skill)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:retro", { cwd: "/abs/repo" }), {
      readInProgressDirImpl: async () => [],
      readFileImpl: async () => "",
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.storyId).toBeUndefined();
  });

  it("does NOT guess under concurrency (multiple in-progress manifests)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:run", { cwd: "/abs/repo" }), {
      readInProgressDirImpl: async () => [
        "native:01STORYAAA.yaml",
        "native:01STORYBBB.yaml",
      ],
      readFileImpl: async (filePath: string) =>
        filePath.includes("AAA")
          ? `ref: "native:01STORYAAA"\nstatus: in-progress\n`
          : `ref: "native:01STORYBBB"\nstatus: in-progress\n`,
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    expect(calls).toHaveLength(1);
    // Ambiguous → no attribution rather than a wrong one.
    expect(calls[0]!.storyId).toBeUndefined();
  });

  it("ignores snapshot baselines and non-in-progress manifests when resolving the active ref", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await captureSkillInvoke(skillPayload("flow:run", { cwd: "/abs/repo" }), {
      readInProgressDirImpl: async () => [
        "native:01STORYAAA.snapshot.yaml", // claim baseline — not a manifest
        "native:01STORYBBB.yaml", // a stray non-in-progress manifest
        "native:01STORYCCC.yaml", // the one real in-progress story
      ],
      readFileImpl: async (filePath: string) => {
        if (filePath.includes("snapshot")) return `ref: "native:01STORYAAA"\nstatus: to-do\n`;
        if (filePath.includes("BBB")) return `ref: "native:01STORYBBB"\nstatus: to-do\n`;
        return `ref: "native:01STORYCCC"\nstatus: in-progress\n`;
      },
      recordImpl: async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return { recorded: true as const };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.storyId).toBe("native:01STORYCCC");
  });

  it("fail-soft: an unreadable in-progress dir yields no story_id, still records", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await captureSkillInvoke(
      skillPayload("flow:run", { cwd: "/abs/repo" }),
      {
        readInProgressDirImpl: async () => {
          throw new Error("boom");
        },
        recordImpl: async (opts) => {
          calls.push(opts as unknown as Record<string, unknown>);
          return { recorded: true as const };
        },
      },
    );
    expect(result).toEqual({ recorded: true });
    expect(calls[0]!.storyId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC3 — fail-soft: never throws, never records on bad input
// ---------------------------------------------------------------------------

describe("captureSkillInvoke — AC3 fail-soft", () => {
  it("returns recorded:false (no throw) for malformed payloads", async () => {
    const calls: unknown[] = [];
    const recordImpl = async (opts: unknown) => {
      calls.push(opts);
      return { recorded: true as const };
    };
    for (const bad of [
      null,
      undefined,
      "not-an-object",
      42,
      {},
      { tool_name: "Bash" },
      { tool_name: "Skill" }, // no tool_input
      { tool_name: "Skill", tool_input: {} }, // no skill
      { tool_name: "Skill", tool_input: { skill: "" } }, // empty skill
    ]) {
      const result = await captureSkillInvoke(bad, { recordImpl });
      expect(result.recorded).toBe(false);
    }
    // Not one of those bad payloads reached the recorder.
    expect(calls).toHaveLength(0);
  });

  it("swallows a downstream recorder error and reports recorded:false", async () => {
    const result = await captureSkillInvoke(skillPayload("flow:board"), {
      recordImpl: async () => {
        throw new Error("telemetry disk full");
      },
    });
    expect(result.recorded).toBe(false);
    expect(result.reason).toBe("telemetry disk full");
  });

  it("the hook script exits 0 even on garbage input and a missing CLI", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../../../../scripts/skill-invoke-hook.sh",
    );
    const proc = spawnSync("bash", [scriptPath], {
      input: "not-json-at-all",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: "/nonexistent/plugin/root" },
      encoding: "utf8",
    });
    expect(proc.status).toBe(0);
  });
});
