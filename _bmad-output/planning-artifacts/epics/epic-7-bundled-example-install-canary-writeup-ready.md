# Epic 7: Bundled Example & Install Canary — Writeup-Ready

A first-time user on a clean machine clones the repo, follows the README, runs the canonical scenario against the bundled example, and reaches a first merged PR in under an hour.

## Status (2026-05-27 reframe)

Epic 7 is **deferred past the self-bootstrap ship gate.** Its canonical scenario ("external stranger installs cold and reaches first merged PR in <1hr") is the **writeup-supporting / stretch gate**, not the v1 ship gate.

The substantive work below still ships — bundled example, README install path, e2e canary — but timing follows **Epic 6b** (after self-bootstrap is demonstrably stable across multiple cycles), not 6a. A failed external-user attempt at this stretch stage remains a valuable signal: it produces the first non-Jack data point on the install path and is grist for the eventual writeup.

See `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` and memory `project_ship_gate_self_bootstrap`.

## Story 7.1: Bundled BMad-shaped example target repo

As a first-time plugin operator,
I want a primed example target repo shipped with the plugin,
So that I can run the canonical scenario before trusting the plugin with my own work.

**Acceptance Criteria:**

**Given** the plugin tree, **When** I look at `plugins/flow/example/`, **Then** it contains a BMad-shaped source story tree under `_bmad-output/.../stories/`, a populated `docs/standards.md` (≤10 criteria), a `docs/risk-tiering.md`, and `.flow/config.yaml` with `adapter: bmad`. _(FR72)_

**Given** the example,
**When** I run `/<plugin>:scan` against it,
**Then** a primed `to-do/` queue is produced with at least 5 stories, including a ship-gate story.

**Given** the bundled example,
**When** it ships,
**Then** its seeded telemetry is calibrated so the first low-risk PR Maya runs auto-merges (canary in Story 7.3 passes), but the second one she runs pauses for human — the verdict→pause loop fires at least once during the canonical scenario. Done via a deliberately-low seeded agreement count that crosses threshold mid-scenario.

**AC4 (integration):** vitest copies `example/` to a temp dir and asserts (a) scan-and-validate succeed, (b) the seeded telemetry pattern produces auto-merge → pause → resume across the example's primed queue.

## Story 7.2: README install path with verifiable checkpoints

As a first-time plugin operator,
I want the README to walk me from clean machine to first merged PR in clearly numbered steps,
So that I never have to guess what "done" looks like at each stage.

**Acceptance Criteria:**

**Given** the top-level README,
**When** a new user reads it,
**Then** it lists in order: (1) install Claude Code, (2) clone repo + load plugin, (3) copy `docs/standards-example.md` to target's `docs/standards.md`, (4) optional risk-tiering override, (5) run `/status` and see the expected line, (6) run `/hire` (or `/skip-hiring`), (7) run `/scan`, (8) run `/start` and `/watch`, (9) merge first PR. Each step has a single verifiable checkpoint. _(FR73)_

**Given** the README, **When** I run a doc-lint check, **Then** every checkpoint references an artifact (a CLI line, a file, a label) that the e2e canary in Story 7.3 actually produces.

**AC3 (integration):** README is exercised end-to-end against `example/` in CI via Story 7.3.

## Story 7.3: E2e canary vitest drive of the canonical scenario

As a plugin maintainer,
I want the canonical scenario driven against a temp clone of `example/` in CI,
So that "install-to-first-merged-PR ≤1 hour" stays true across changes.

**Acceptance Criteria:**

**Given** the e2e canary suite,
**When** CI runs,
**Then** it copies `example/` to a temp directory, runs `/skip-hiring`, `/scan`, `/start`, and asserts at least one PR reaches `READY FOR MERGE` and auto-merges (low-risk + agreement threshold seeded high enough to pass). _(NFR5)_

**Given** the canary, **When** any of the README's checkpoint artifacts fail to appear, **Then** CI fails citing the missing checkpoint.

**Given** the canary's wall-clock measurement,
**When** the run completes,
**Then** the total elapsed time is reported in the CI output for regression tracking against the NFR5 ≤1-hour target.

**AC4 (integration):** the canary is the CI gate.

## Story 7.4: First-run polish and plain-language pass

As a first-time non-engineer plugin operator,
I want every error message I see on the install path written in plain language,
So that I'm never stranded staring at a stack trace I can't decode.

**Acceptance Criteria:**

**Given** the error messages emitted by Stories 1.2, 1.3, 2.4, 3.5, and 4.5,
**When** a plain-language pass is conducted,
**Then** each error names what's wrong, where to look, and what to do next — without TypeScript type names or stack traces as the primary content. _(FR77 spirit, NFR5)_

**Given** the `/skip-hiring` happy path, **When** a first-time user runs it after copying the standards template, **Then** the entire flow completes with no follow-up prompts.

**Given** the canonical scenario as exercised by Story 7.3,
**When** Jack times a fresh-clone-to-first-merged-PR run on his own machine,
**Then** the elapsed wall-clock is ≤1 hour, including reading the README. _(NFR5)_

**AC4 (integration):** Jack's timed run is recorded as a v1 ship gate in the release checklist.

## Story 7.4b: Plain-language pass over orchestration surfaces

As a non-engineer plugin operator,
I want every orchestration surface line written in plain language,
So that `[source-drift]` or `[stale-claim]` or `[routing-failure]` tells me what's happening and what to do — not just jargon to look up.

**Acceptance Criteria:**

**Given** every surface prefix tag from Story 5.5 (`[blocked]`, `[stuck]`, `[stale-claim]`, `[source-drift]`, `[routing-failure]`, `[paused-for-human]`),
**When** the tag first appears in a session's terminal output,
**Then** a plain-language one-line explanation is appended on first appearance (e.g. `[source-drift]` first-shown: _"means the story's source file was edited while we were working on it — open the source and decide whether to keep the new version"_).

**Given** repeated occurrences of the same tag in the same session,
**When** orchestration surfaces them,
**Then** the explanation is not re-printed (one explanation per tag per session).

**Given** the plain-language explanations,
**When** the doc-lint check from Story 7.2 runs,
**Then** every surface tag in the source has a matching plain-language entry; CI fails on drift.

**AC4 (integration):** vitest seeds one of each blocker condition and asserts (a) plain-language explanation prints on first appearance, (b) explanation does not print on second appearance, (c) explanation text matches the doc-lint registry.

## Story 7.5: Authoritative troubleshooting guide

As a first-time plugin operator who hits an error mid-install,
I want a single troubleshooting page that names every failure path I might hit and the recovery action,
So that I can unstick myself without filing an issue or reading source.

**Acceptance Criteria:**

**Given** the failure paths surfaced in Stories 1.3 (standards missing/malformed), 3.5 (planning-discipline block), 4.5 (`gh` recoverable errors), 5.4 (stuck / stale claims), 5.5 (source-drift / routing-failure), and 5.8 (catch-all failure log),
**When** I read `plugins/<plugin>/docs/troubleshooting.md`,
**Then** each failure path has a section with (a) the exact error string or surface line, (b) what it means in plain language, (c) the recovery action. _(PRD Risk 1 mitigation: writeup-grade artifact)_

**Given** the troubleshooting page,
**When** the doc-lint check from Story 7.2 runs,
**Then** every error string in the troubleshooting guide is one the plugin actually emits (no stale entries; CI fails on drift).

**Given** the README install path (Story 7.2),
**When** any checkpoint fails,
**Then** the failure message links to the relevant troubleshooting section by anchor.

**AC4 (integration):** doc-lint asserts every cited error string exists in the plugin source.

## Story 7.6: Telemetry-summary doc generator

As Jack writing the public writeup,
I want a deterministic helper that turns a cycle's JSONL + retro proposals + outcome stats into a paragraph I can paste into the writeup,
So that the writeup's evidence is reproducible and updates as the dog-fooding loop adds data.

**Acceptance Criteria:**

**Given** a cycle's archived state in `sprint-history/<cycle-id>-<ts>.yaml`,
**When** `compute-cycle-summary` runs,
**Then** it returns a structured summary (stories shipped, agreement-metric end-of-cycle, accepted-proposal count by type, rule fire-count deltas, team-composition changes, constructive-to-defensive ratio) — pure deterministic, no LLM. _(PRD Risk 1 + Risk 2 mitigation)_

**Given** the structured summary,
**When** rendered via a Markdown template,
**Then** it produces a writeup-ready paragraph that names the cycle, the headline number, and the most-load-bearing change (rule added / team change / skill codified) in plain language.

**Given** multiple cycles archived,
**When** the helper runs across the full history,
**Then** it produces a cross-cycle summary showing trend lines for agreement metric, accepted-proposal rate, and constructive-to-defensive ratio — the three signals the writeup leans on.

**AC4 (integration):** vitest seeds a fixture sprint-history and asserts both single-cycle and cross-cycle outputs match expected text.

## Story 7.7: Maya-archetype validation paper-test

As Jack about to ship the writeup,
I want a paper-test of the install path against five named candidates who match the Maya archetype,
So that the v1 ship gate isn't predicated on an archetype that has no real-world referents (PRD Risk 2 mitigation).

**Acceptance Criteria:**

**Given** the Maya archetype defined in the PRD ("non-engineer who can read code at skim level; comfortable in terminal and git"),
**When** Jack identifies candidates,
**Then** he can name at least five real people from his network who match the archetype; the list is recorded in `_bmad-output/planning-artifacts/maya-candidates.md` (gitignored — local-only, like other planning artifacts). _(PRD Risk 2)_

**Given** one candidate from the list,
**When** Jack walks them through the README install path (Story 7.2) — without writing code, only screen-sharing —
**Then** the candidate reaches the "I see my first merged PR" checkpoint OR Jack records the specific step at which they got stuck in `maya-candidates.md` as a v1 ship blocker.

**Given** the paper-test result,
**When** Jack sits down to write the public writeup,
**Then** the writeup either cites the successful candidate's experience (anonymised) OR explicitly frames v1 as "tested with one external user, here's where the friction was."

**Given** zero candidates can be named,
**When** Jack assesses the situation,
**Then** v1 is reframed as a Jack-only dog-fooding tool before the writeup goes out — not abandoned, but not shipped to an addressable user category that doesn't exist. _(PRD Risk 2 mitigation: "if the candidate pool feels under five real people Jack can name, the writeup gets reframed before launch")_

**AC4 (integration):** the paper-test outcome is recorded as a v1 ship gate in the release checklist alongside Story 7.4's timed run.

---
