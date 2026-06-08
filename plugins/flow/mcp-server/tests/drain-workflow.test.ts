/**
 * Story 8.5 — drain workflow integrity.
 *
 * The stateless drain runs under the Workflow primitive (`export const meta`,
 * top-level `await`/`return`), so it cannot be unit-executed here. This is a
 * structure/integrity anchor: the script parses, declares its meta, wires the
 * load-bearing seam tools via the one-shot CLI, switches on the verified
 * discriminants, and accounts for every ref in a structured return (the
 * no-silent-failures surface). End-to-end behaviour is exercised in M5.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAIN = path.resolve(HERE, "..", "..", "workflows", "drain.workflow.js");
const SRC = readFileSync(DRAIN, "utf8");

describe("Story 8.5 — drain workflow integrity", () => {
  it("parses as a Workflow-runtime script (export/meta/top-level await+return)", () => {
    // Wrap the body in an async fn so top-level await/return are valid for parse.
    const wrapped = "(async()=>{" + SRC.replace("export const meta", "const meta") + "})()";
    expect(() => new vm.Script(wrapped)).not.toThrow();
  });

  it("declares meta.name = flow-drain with a drain phase", () => {
    expect(SRC).toMatch(/export const meta\s*=/);
    expect(SRC).toContain("name: 'flow-drain'");
    expect(SRC).toContain("title: 'drain'");
  });

  it("wires the load-bearing seam tools via the one-shot CLI", () => {
    for (const tool of [
      "mintSessionUlid",
      "buildPersonaSpawnPrompt",
      "claimNextStory",
      "runDevTerminalAction",
      "processDevTranscript",
      "runReviewerSession",
      "processReviewerTranscript",
      "runAutoMergeGate",
    ]) {
      expect(SRC).toContain(tool);
    }
  });

  it("switches on the verified seam discriminants", () => {
    for (const arm of [
      "spawn-dev",
      "spawn-reviewer",
      "done-ready-for-merge",
      "done-blocked-reviewer-needs-changes",
      "auto-merge",
    ]) {
      expect(SRC).toContain(arm);
    }
  });

  it("accounts for every ref in a structured return (no silent failures)", () => {
    for (const field of ["completed", "merged", "pausedForHuman", "blocked", "drainedReason"]) {
      expect(SRC).toContain(field);
    }
  });

  it("classifies drain exits with explicit reasons (no budget-exhausted mislabel)", () => {
    // The happy unattended path keys off the real claimNextStory empty-queue signal.
    expect(SRC).toContain("queue-drained");
    // Hitting the optional cap is its OWN named exit, not a queue state.
    expect(SRC).toContain("max-stories-reached");
    // `drained` is the positive full-drain signal, not the old sentinel diff.
    expect(SRC).toContain("drained: drainedReason === 'queue-drained'");
    // The mislabelled token-budget placeholder is gone entirely.
    expect(SRC).not.toContain("budget-exhausted");
  });

  it("treats maxStories as an optional cap (unbounded drain until queue empty by default)", () => {
    // No hard default-1 cap: an omitted maxStories drains the whole queue.
    expect(SRC).not.toContain("A.maxStories || 1");
    expect(SRC).toContain("Infinity");
  });

  it("routes courier model by seam kind (Haiku read-only, Sonnet mutating); dev edits inside its own worktree (Story 8.20)", () => {
    // Couriers relay tool JSON verbatim. The model is chosen by the read-only vs
    // mutating axis (the `retryable` flag): read-only/idempotent seams run on the
    // cheaper Haiku (a garble just re-invokes), while MUTATING seams stay on the
    // more-reliable Sonnet — Haiku garbled exactly such a verdict relay on the first
    // multi-story drain (story 8.13), and a garbled mutating relay pauses the story.
    expect(SRC).toContain("model: retryable ? 'haiku' : 'sonnet'");
    // Story 8.20: the dev's EDITING SURFACE is its own worktree — the dev agent is
    // spawned with the runtime's per-agent `isolation: 'worktree'` primitive, so two
    // devs against the same repo can never cross-contaminate edits. This is what
    // makes the deferred concurrent dispatch (bmad:8.22) safe by construction.
    expect(SRC).toContain("isolation: 'worktree'");
    // The 8.16 snapshot-baseline/transplant workaround is gone (it was serial-only).
    expect(SRC).not.toContain("snapshotDirtyPaths");
    expect(SRC).not.toContain("baselineDirtyPaths");
    // Crash-recovery reaps stale dev worktrees left by dead sessions (8.20 AC4).
    expect(SRC).toContain("reapStaleWorktrees");
  });

  it("retries the relay only on read-only/idempotent seams (mutating seams pause safely)", () => {
    // The seam helper takes a `retryable` flag (default false) and re-invokes the
    // courier on a garbled (non-JSON) relay.
    expect(SRC).toContain("retryable = false");
    // Read-only / idempotent seams opt in: mint, persona, processDevTranscript.
    expect(SRC).toContain("'mint', true");
    expect(SRC).toContain("'persona:dev', true");
    // Mutating seams (claim / verdict / gate) omit retryable → a garble surfaces as a
    // parse error and the loop pauses that story rather than risk a double-apply.
  });
});
