---
date: 2026-05-29 (workflow-pivot planning session)
author: Jack (PM decisions) + Claude (analysis + drafting)
scope: **Major** — swaps the orchestration substrate; touches Architecture and Epics 4/5/6, authorises net-new workstreams, and re-sequences the epic plan. Product behaviour / PRD unchanged.
trigger: The 2026-05-29 stateless-workflow spike — the persistent-MCP-server disconnect that has blocked every clean autonomous cycle is removed *by construction* when the crew tools run as stateless one-shot processes under the Workflow primitive.
supersedes: the daemon-survival workstream (stories 5.12 / 5.25 / 5.30 / 5.31 / 5.32) and the `/flow:start`-loop + `/watch`-polling orchestration model.
status: **APPROVED (PM, 2026-05-29 planning session)** — core decisions confirmed (go stateless; Stage-1 dogfood target; governed self-evolution). This proposal authorises Stage-1 story authoring (via bmad-create-story) and the archive actions in §4. The two filing choices in §5 remain open.
---

# Sprint Change Proposal — Pivot to the Stateless Workflow Substrate

## 1. Issue Summary

crew's continuous-flow loop (the always-on MCP server driving `/flow:start`) has **never completed one clean autonomous cycle** — the server is SIGTERM-cascaded whenever a subagent returns, stalling the loop mid-drain. The prior fix attempt (a parent-owned detached daemon, stories 5.31/5.32) was unproven.

The **2026-05-29 spike** established a better answer: run the crew tools as **stateless one-shot CLI processes** under the dynamic **Workflow** primitive (deterministic JS scripts that spawn one-shot subagents). There is no long-lived process to kill, so the disconnect is **gone by construction** — the spike ran a full claim→dev→PR→review→merge cycle this way *while the old daemon was simultaneously throwing keepalive timeouts*. It also surfaced and fixed a second, independent, deterministic blocker (a commit-message regex that rejected every real story ref).

**Decision (PM-confirmed): pivot the orchestration substrate to stateless Workflow scripts. Reuse the existing tool layer; replace only the orchestration. Cancel the persistent-daemon workstream.**

## 2. Impact Analysis

**Headline: ~80% of shipped engineering survives.** Every load-bearing decision tool the design depends on (claim, dev-handoff parse, verdict derivation, risk-tier, auto-merge, scan, persona/retro machinery) already exists, built across Epics 1–6. The pivot rewrites *how those tools are driven* (workflow scripts over one-shot CLI seam-agents, not an MCP-daemon-backed `/flow:start` loop) and **deletes the daemon-survival work**. Because we chose stateless, the original design's single hardest prerequisite — proving a detached daemon survives the `agent()`-return path — is **moot**, which materially lowers pivot risk.

### Artefact impact

| Artefact | Impact |
|---|---|
| `prd-crew-v1/**` (all shards) | **No change.** Operator experience, scope, success criteria, user journeys all hold — the engine swaps, the product doesn't. |
| `architecture/core-architectural-decisions.md` | **Revise.** "Single persistent MCP server" topology, the Task-tool per-story agent-invocation model, and the 10-step implementation sequence are superseded by stateless one-shot seams + the §11 build order. Recovery leads with filesystem-position, not heartbeat. |
| `architecture/implementation-patterns-consistency-rules.md` | **Revise.** §8 (SKILL.md prose orchestration) → loop control moves into the workflow script; §7/§12 (locked-phrase grammar) → verdict transports via the reviewer-result *file*, not chat. Tool-naming, frontmatter, JSONL, TS, commit/PR conventions all survive. |
| `architecture/skill-calibration-loop.md` | **Minor revise.** Reframe `/accept-proposal` as the `apply` run-boundary; proposal types, telemetry, effectiveness helpers all survive. |
| `epics/epic-4-...md` (dev-review loop) | **Revise** → becomes the serial `drain` workflow. All decision tools reused; `/flow:start` skill + prose seams (4.2/4.3b/4.3c) replaced by `drain.workflow.js`. |
| `epics/epic-5-...md` (orchestration/recovery) | **Supersede→archive (majority).** Daemon-survival (5.12/5.25/5.30/5.31/5.32) and `/watch` polling (5.3/5.4/5.5) superseded. Recovery model = filesystem position + workflow resume-journal. **Bug-fix code (≈15 stories) MUST be preserved** (see caution below). |
| `epics/epic-6-...md` (calibration) | **Revise** → retro/apply workflows. 6.1–6.3 (proposal drafting) reused as-is; 6b apply tools map to the `apply` workflow. |
| `epics/epic-list.md`, `overview.md` | **Replace** with the revised epic set (§3); archive the pre-pivot copies. |
| `epics/epic-1/2/3/7` | **Keep/light-revise.** Tool layer reused; only orchestration shells re-home to workflows. |
| `sprint-status.yaml` | **Inserts** for the Stage-1 build stories (§4). No status flips on existing rows. |
| UX specs | **N/A** — crew is a CLI plugin, no UI. |

### Technical impact / must-preserve caution

The spike's CLI shim (`plugins/flow/mcp-server/src/cli.ts`) already exposes 16 of the seam tools as one-shot commands. **Do not archive by deletion:** ≈15 Epic-5 stories are live bug fixes (the reviewer-verifies-nothing fix line, parser-widening, orphan recovery, the commit-message fix). Their *specs* may archive; their *code + tests* are part of the silent-failure baseline and must be inventoried before the Epic-5 file moves, or the new engine silently re-inherits defects already paid for.

## 3. Recommended Approach

### 3.1 Sequence for the soonest proof-point — staged "fastest path to dogfooding"

Rather than build the full revised epic set in order, optimise for the soonest "crew builds crew."

- **Stage 1 (near-term target, PM-confirmed):** one fully-autonomous `drain` run on crew's *own* repo that takes a real low-risk story claim→dev(opens a real PR)→reviewer→green "READY FOR MERGE" with **zero human up to the green PR; a human merges.** Requires only: three small fixes (commit-scope, the AC-regex divergence, agent-discipline tightening) + productionising the CLI shim + the `drain` workflow + one bootstrap story.
- **Stage 2 (fast-follow):** zero-human merge via cold-start provisional-trust (the formal ship-gate). Net-new gate work; crew's history has no merge-observations today so every low-risk PR currently pauses correctly.

### 3.2 How the team learns and evolves — governed self-evolution (PM-confirmed)

The team evolves its own skills, workflow, and standards by **proposing** changes (skill create/revise/retire, rule add/retire, sharpened standards, team reshape) that the human approves and tools apply deterministically — **never silent in-context drift.** The deterministic spine constrains *bookkeeping and control flow*, not the agents' reasoning, so evolution is auditable, reversible, and compounding. **Priority follow-on after dogfooding (ahead of Stage 2):** build the **apply/write-back half** of the calibration loop (6.1–6.3 already *draft* proposals; the deferred piece *applies* an approved proposal into persona Knowledge / standards / skills / team). Until it lands, the team proposes and a human applies.

### 3.3 Revised epic structure (target re-sequence)

| New epic | What it is | Derived from |
|---|---|---|
| **A — Silent-failure audit** *(prerequisite)* | Fix the tools that fail *quietly* (reviewer-verifies-nothing, scan loud-arms, commit-message bug). | new + Epic 5 fixes |
| **B — The drain workflow** | Engineering heart, rebuilt as a stateless workflow run over existing tools. | Epic 4 |
| **C — Cold-start trust** | First-PR zero-human merge (Stage 2). | new + Epic 4 gate |
| **D — Scan + plan runs** | Backlog priming as runs; closes two scan bugs. | Epic 3 |
| **E — Hire + retro/apply runs** | Team formation + the learning loop across gates. | Epics 2 + 6 |
| **F — Outer driver** | Watcher that chains runs across human gates ("walk away, come back to merged PRs"). | new (replaces `/watch`) |
| **G — Bundled example + canary** | Ship gate; stays deferred. | Epic 7 |

The old daemon-precondition epic is **dropped** (moot under stateless).

## 4. Detailed Change Proposals

### 4.1 Stage-1 build stories (to be authored via `bmad-create-story` — never hand-written)

| Ref | Story | Files | Size |
|---|---|---|---|
| M0 | Commit-scope regex accepts real refs (`bmad:`/`native:`) | `src/lib/git.ts:54` (fix staged in `wf-drain-fix` worktree) | XS |
| M1 | **AC-heading regex alignment** (reviewer must parse em-dash ACs — closes the verifies-nothing bug; 41 headings affected) | `src/lib/extract-acs-from-spec.ts:50` + tests | S |
| M2 | Agent-discipline: evidence-only (never write the manifest; preserve judgment) | `catalogue/generalist-dev.md`, `generalist-reviewer.md` + team copies | S |
| M3 | Productionise the CLI shim + wire `processReviewerYield`, `scanOrphanedInProgress` | `src/cli.ts` (+ dist) | S–M |
| M4 | `drain.workflow.js` — stateless serial drain, one-story scope, parameterised tunables | `plugins/flow/workflows/drain.workflow.js` (net-new) | M |
| M5 | Bootstrap story + dogfood run + verification | authored via bmad-create-story; run + verify | S + run |

### 4.2 Archive actions (per crew convention: `planning-artifacts/archive/` is gitignored)

- **Archive (after the revised epics are authored):** the Epic-5 file, the pre-pivot `epic-list.md`/`overview.md`, and pre-pivot copies of the three revised architecture docs → `planning-artifacts/archive/`.
- **Keep in place, marked superseded (do not move):** all `implementation-artifacts/**` story specs (shipped record + cloud-routine input + bug-fix provenance). Mark via `Status:` frontmatter, not by moving files.

### 4.3 sprint-status.yaml inserts (Stage-1)

```yaml
# Stage-1 pivot build (refs finalised at bmad-create-story time)
m0-commit-scope-regex-real-refs: backlog
m1-reviewer-ac-heading-regex-alignment: backlog
m2-agent-discipline-evidence-only: backlog
m3-cli-shim-productionise-and-wire: backlog
m4-drain-workflow-stateless: backlog
m5-bootstrap-story-and-dogfood-run: backlog
```

## 5. Open Decisions for Jack

**Q1 — Where do the Stage-1 stories live?** (a) **A new epic (recommended)** — e.g. "Epic 8 — Stateless workflow substrate + Stage-1 dogfood" holding M0–M5, keeping the pivot build coherent and traceable; the full A–G re-number lands later. (b) Append M0–M2 to their natural epics (4/5) and put M3–M5 under a new substrate epic — more "correct" homing but fragments the pivot narrative.

**Q2 — Archive timing.** (a) **Archive after the revised epics are authored (recommended)** — no window where the plan has no epic file. (b) Archive now — cleaner immediately but leaves a gap until the new epics exist.

## 6. Implementation Handoff

**Scope classification: Major** — but mechanically additive (no story rows deleted/renumbered; archives are reversible; PRD untouched).

**If approved (Q1/Q2 settled):**
1. Author M0–M5 via `bmad-create-story` under the chosen epic home.
2. Ship M0 + M1 first (pivot-independent fixes, PRs to `dev` via `/ship-story`); then M2/M3; then M4.
3. Author + prime the bootstrap story; run `drain.workflow.js` (`maxStories:1`).
4. **Declare Stage 1 green only on evidence:** a green PR *and* `reviewer-result.json` `acResults` non-empty and all-pass (proves real AC verification, not the false-green failure mode M1 fixes).
5. Execute the §4.2 archive actions.

**Success criterion for this proposal:** one autonomous drain run produces a green, genuinely-self-reviewed PR on crew's own backlog — dogfooding begins.

---

## Addendum — corrections from the backlog assessment (2026-05-29)

A read-through of all unbuilt Epic 5/6/7 work against the pivot confirmed **the Stage-1 path is unchanged**, and surfaced these corrections to §2/§4:

1. **5.32 daemon is MERGED, not unbuilt.** PR #181 (merged to `dev` 2026-05-28) shipped the detached proxy + parent-owned daemon; `plugin.json` currently boots `mcp-proxy/bin/mcp-proxy.js` — which contradicts the stateless model. **PM decision: retire after the dogfood** — keep it through Stage 1 (the drain bypasses it via the CLI; interactive priming still uses it), then in the cleanup pass revert `plugin.json` to launch the MCP server directly and remove `mcp-proxy/`. So the supersede of 5.32 is a **code change**, not just a spec archive. (Consequently the build brief's §7 / §11-step-2 "daemon precondition" is **obsolete** — do not schedule that spike.)

2. **Status drift to reconcile (in the archive/supersede pass):** `5-32`, `6-1`, `6-2`, `6-3` show `ready-for-dev` but are merged. Set `5-32` → superseded; `6-1/6-2/6-3` → done. So the retro *drafting* half of the calibration loop already exists on disk; only the **apply/write-back half (6.4–6.10)** remains — which sharpens it as the **#1 post-dogfood priority**.

3. **Two net-new gaps to author (post-dogfood, NOT Stage-1 blockers):**
   - **Scan loud-arms** (`nothingMatched`, `ambiguousPrefixCollisions`) — net-new tool work → revised Epic A/D. Safe to defer: we author/control the bootstrap story so the silent-skip can't bite the dogfood.
   - **Non-drain workflow shells** (`scan`/`plan`/`hire`/`retro` as `.workflow.js`) — only `drain` is authored → revised Epics D/E. Safe to defer: Stage 1 primes via the existing interactive skills.

4. **Backlog classification (no change to Stage 1):** Epic 5 daemon/`/watch` line **superseded**; its taxonomy/surface/recovery-test stories **reshaped** workflow-native; Epic 6 retro tools **survive**, the apply loop **reshaped + elevated**; Epic 7 **reshaped/deferred** as the ship gate (its bundled example must also seed cold-start trust state). PRD-deferred set **unchanged**.
