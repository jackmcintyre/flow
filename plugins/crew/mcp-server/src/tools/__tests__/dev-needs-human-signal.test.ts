/**
 * Unit/integration tests for the dev "needs human decision" signal — Story 8.19 AC1.
 *
 * AC1: there is a defined, parseable way for the dev step to signal that the
 * story has hit a decision a human must make, carrying the question text,
 * distinct from a normal handoff, a domain-yield, and a hard block. The drain's
 * dev-transcript processing (`processDevTranscript`) recognises this signal and
 * routes the story to a human-needed outcome rather than treating it as a
 * successful handoff or a silent failure. This vitest drives the dev step
 * emitting the signal and asserts the story is routed to the human-needed
 * outcome with the question text preserved verbatim — NOT to completed
 * (`spawn-reviewer`), and NOT to a generic blocked-with-no-reason.
 *
 * Uses a real tmpdir with real `node:fs` ops — no module mocking; the tool
 * composes pure pieces and the test exercises the real composition (mirrors
 * process-dev-transcript.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { devOutcomeFilePath } from "../../lib/read-dev-outcome-file.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { processDevTranscript } from "../process-dev-transcript.js";
import type { ExecutionManifest } from "../../schemas/execution-manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_REF = "bmad:8.19";
const SESSION_ULID = "01HZSESSION00000000000019";
const HANDOFF_PHRASE = `Handoff to reviewer — story ${STORY_REF} ready for review.`;
const QUESTION =
  "Should the rate-limit header be `X-RateLimit-Remaining` (GitHub style) or `RateLimit-Remaining` (RFC draft)? They have different downstream consumers.";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBaseManifest(ref: string): ExecutionManifest {
  return {
    ref,
    status: "in-progress",
    adapter: "bmad",
    source_path: `_bmad-output/implementation-artifacts/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
    title: "Test Story",
    narrative: "As a dev, I want to test.",
    withdrawn: false,
    ready: true,
    claimed_by: SESSION_ULID,
  };
}

const FIXTURE_REVIEWER_PERSONA_MD = `---
role: generalist-reviewer
domain: "code review in a story scope"
model_tier: sonnet
tools_allow:
  - Read
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Reviewer

## Domain

Reviews one story at a time.

## Mandate

- Review stories.

## Out of mandate

- Implementing.

## Prompt

You are the generalist reviewer.

## Knowledge

No knowledge yet.
`;

let tmpRoot: string;
let manifestPath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-dev-needs-human-"));
  await fs.mkdir(path.join(tmpRoot, ".crew", "state", "in-progress"), {
    recursive: true,
  });
  manifestPath = path.join(
    tmpRoot,
    ".crew",
    "state",
    "in-progress",
    `${STORY_REF}.yaml`,
  );
  await atomicWriteFile(
    manifestPath,
    yamlStringify(makeBaseManifest(STORY_REF), { lineWidth: 0 }),
  );

  // Seed the reviewer persona so the happy-handoff path (used by the
  // "distinct from a successful handoff" case) can build the reviewer prompt.
  await fs.mkdir(path.join(tmpRoot, "team", "generalist-reviewer"), {
    recursive: true,
  });
  await atomicWriteFile(
    path.join(tmpRoot, "team", "generalist-reviewer", "PERSONA.md"),
    FIXTURE_REVIEWER_PERSONA_MD,
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readOnDiskManifest(): Promise<ExecutionManifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  return parseExecutionManifest(yamlParse(raw) as unknown, { absPath: manifestPath });
}

// ---------------------------------------------------------------------------
// AC1 — the signal routes to the human-needed outcome with the verbatim question
// ---------------------------------------------------------------------------

describe("dev needs-human-decision signal (Story 8.19 AC1)", () => {
  it("routes to done-needs-human-decision carrying the verbatim question — NOT spawn-reviewer", async () => {
    const transcript = `I implemented the scaffolding but hit a genuine fork.\nneeds-human-decision: ${QUESTION}`;

    const result = await processDevTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: transcript,
    });

    expect(result.next).toBe("done-needs-human-decision");
    if (result.next !== "done-needs-human-decision") return;

    // The question text is preserved VERBATIM.
    expect(result.question).toBe(QUESTION);

    // It is NOT routed to completed (spawn-reviewer) and carries a real reason
    // (the chatLog names the story and the question — not a bare block).
    expect(result.chatLog.join("\n")).toContain(QUESTION);
    expect(result.chatLog.join("\n")).toContain(STORY_REF);
  });

  it("is distinct from a successful handoff — a transcript with ONLY the handoff phrase goes to spawn-reviewer, not human-needed", async () => {
    // No PR-URL fallback is needed because we seed dev-outcome.json? No — the
    // simplest distinction proof: the needs-human path never fires for a plain
    // handoff. We assert the handoff path is NOT classified as needs-human.
    const transcript = `Did the work.\n${HANDOFF_PHRASE}`;
    // Seed a dev-outcome.json so the handoff path can resolve a prNumber.
    // Per-ref namespaced path (story native:01KT3YDHM10FPQ77N22BTJP9AF):
    // atomicWriteFile creates parent dirs internally.
    await atomicWriteFile(
      devOutcomeFilePath(tmpRoot, SESSION_ULID, STORY_REF),
      JSON.stringify({
        prNumber: 77,
        prUrl: "https://github.com/o/r/pull/77",
        branch: "crew/bmad-8-19",
        commitSha: "abc1234",
      }),
    );

    const result = await processDevTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: transcript,
    });

    expect(result.next).toBe("spawn-reviewer");
    const onDisk = await readOnDiskManifest();
    // Not stamped with the pause marker.
    expect(onDisk.blocked_by).toBeUndefined();
  });

  it("stamps a descriptive blocked_by (needs-human-decision) — not a generic block-with-no-reason", async () => {
    await processDevTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: `needs-human-decision: ${QUESTION}`,
    });

    const onDisk = await readOnDiskManifest();
    expect(onDisk.blocked_by).toBe("needs-human-decision");
  });

  it("takes precedence over a coexisting handoff phrase (a deliberate decision signal wins)", async () => {
    const transcript = `needs-human-decision: ${QUESTION}\n${HANDOFF_PHRASE}`;

    const result = await processDevTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: transcript,
    });

    expect(result.next).toBe("done-needs-human-decision");
    if (result.next !== "done-needs-human-decision") return;
    expect(result.question).toBe(QUESTION);
  });

  it("a blank/whitespace-only question does NOT qualify — falls through to a block, never a silent pause", async () => {
    const transcript = `needs-human-decision:    \nnothing concrete here`;

    const result = await processDevTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: transcript,
    });

    // No concrete question → not a pause; it falls through to the handoff parse
    // which blocks on grammar drift (the dev did not finish cleanly).
    expect(result.next).toBe("done-blocked-handoff-grammar");
  });

  it("preserves a multi-clause question with punctuation and code spans verbatim", async () => {
    const tricky =
      "Use `setTimeout` or `setInterval` for the poll? The first is one-shot; the second risks overlap — which does the AC intend?";
    const result = await processDevTranscript({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      devTranscript: `Hit a fork.\nneeds-human-decision: ${tricky}`,
    });

    expect(result.next).toBe("done-needs-human-decision");
    if (result.next !== "done-needs-human-decision") return;
    expect(result.question).toBe(tricky);
  });
});
