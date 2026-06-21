# Story 9.1: Readiness brake + minimal intake cockpit

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **an explicit `ready` flag I control on each backlog item, with the drain claiming only items I've marked ready**,
So that **nothing gets built until I've blessed it — I can prime and curate a backlog freely, and the dev loop never picks up a story I haven't released**.

This is the spine of Epic 9 (the intake cockpit). Today the drain claims any backlog item whose dependencies are satisfied — there is no operator brake between "exists in the backlog" and "the dev loop will build this." This story adds that brake: a positive, operator-controlled `ready` gate, and a minimal command to see the backlog and toggle readiness. It ships **only the brake** — no judging panel, no author seam, no proposing or ordering of features. The operator blesses by hand for now; the judge panel that blesses automatically arrives in later stories.

The change has a near-exact precedent in the codebase: the existing **`withdrawn`** flag is already an orthogonal, operator-set boolean on the backlog manifest, toggled by a dedicated tool and honoured by the claim filter. `ready` is the same shape with the polarity flipped — `withdrawn` removes an item from claiming; `ready` is required to admit one. Mirror that precedent rather than inventing a new pattern.

## Dependencies

- **No hard story dependency.** This operates on backlog manifests already produced by the Epic 3 scan layer and consumed by the Epic 4/8 claim path; both already exist and ship.
- **Is a prerequisite for** the rest of Epic 9. The author seam (9.2) drafts items into this backlog; the judge panel (9.3) and Quality Lead (9.4) become the automated path that sets `ready`; the dashboard (9.5) renders readiness. All of them assume the `ready` gate this story defines.
- **Touches the drain's claim filter**, which is load-bearing for the live drain — see the risk note. The change is additive (a stricter filter) and default-closed, so an un-blessed backlog simply yields nothing to claim rather than misbehaving.

## Acceptance Criteria

**AC1 — the drain claims only blessed items (integration):**

The claim path's eligibility predicate requires both dependency-readiness **and** the new operator `ready` flag. A backlog item whose dependencies are all satisfied but which has not been marked ready is never returned by the next-story claim entry point; once it is marked ready it becomes eligible and is claimed. A vitest seeds two dependency-satisfied backlog manifests — one not-ready, one ready — and asserts the claim entry point returns the ready one and never the not-ready one; it then marks the not-ready item ready and asserts the claim entry point now selects it.
vitest: plugins/crew/mcp-server/src/tools/__tests__/claim-next-story.test.ts

**AC2 — `ready` is an additive, default-closed manifest field (integration):**

The execution-manifest schema gains a `ready` boolean defaulting to `false`, orthogonal to both `status` and `withdrawn` (it is not a status value and triggers no state-directory move). A manifest authored before this field existed still parses cleanly, reading as not-ready; the schema's strict posture is preserved and no existing field is weakened. A vitest parses a manifest lacking the field (asserts it reads false), parses one carrying it true (asserts true), and asserts the strict schema still rejects unknown keys.
vitest: plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts

**AC3 — a mark-ready tool toggles the flag on a backlog item without moving it, idempotently (integration):**

A new MCP tool sets the `ready` flag true or false on a named backlog item, writing the manifest back through the same managed write path the withdraw tool uses, leaving `status` and the item's state directory untouched. Setting the flag to the value it already holds is a no-op (no write, no event). A reference that is not an un-claimed backlog item raises a typed domain error rather than mutating anything. A vitest marks a backlog item ready (asserts the manifest flag flips and the item stays in the backlog state), re-marks it ready (asserts a no-op), marks it not-ready (asserts it flips back), and asserts an unknown reference raises the typed error.
vitest: plugins/crew/mcp-server/src/tools/__tests__/mark-story-ready.test.ts

**AC4 — a real toggle emits exactly one readiness telemetry event (integration):**

A new closed-enum telemetry event records a readiness change, carrying the item reference and the new flag value. Exactly one event is emitted per real toggle and none on an idempotent no-op or on the typed-error path. The event variant is added additively to the telemetry discriminated union, preserving its strict posture. A vitest drives one real toggle and asserts a single readiness event lands with the right reference and value, and asserts no event is emitted for a no-op re-toggle.
vitest: plugins/crew/mcp-server/src/tools/__tests__/mark-story-ready.test.ts

**AC5 — freshly scanned items default to not-ready (integration):**

The scan step writes new backlog manifests with `ready` defaulting to `false`, so a just-scanned item is in the backlog but not claimable until the operator blesses it. A vitest scans a source story into a fresh backlog manifest, asserts the written manifest reads not-ready, and asserts the claim entry point does not return it.
vitest: plugins/crew/mcp-server/src/tools/__tests__/scan-sources.test.ts

**AC6 — a `/crew:ready` operator skill lists the backlog and drives the toggle (artifact):**

A skill file defines the operator command that lists backlog items with their readiness and dependency state and calls the mark-ready tool to toggle a chosen item. Its frontmatter lists the mark-ready tool in `allowed_tools`; its body never instructs a direct manifest write or git call — every mutation flows through the tool. The file exists at the skill path and is shaped like the other crew skills.
artifact: plugins/crew/skills/ready/SKILL.md

**AC7 — the tool is registered with the DomainError envelope and a typed error (artifact):**

The mark-ready MCP tool is registered in the tool registry with the standard `DomainError` envelope, and its new typed error (the not-an-eligible-item error) is defined in the errors module extending `DomainError`. The optional `ready` field and the new telemetry variant are both additive — existing manifests and the existing event union are unweakened.
artifact: plugins/crew/mcp-server/src/tools/register.ts

## Definition of Done

- [ ] All seven ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new/updated test files cover every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC5 are runnable vitest, AC6–AC7 are file-presence; the reviewer's runnable-AC pass should be all-green.
- [ ] The claim-filter change is additive and default-closed: an un-blessed backlog yields nothing to claim rather than misbehaving. No change to status transitions or state-directory moves.
- [ ] Schema and telemetry changes are additive only — strict posture and existing variants preserved; `ready` defaults false.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds (the brake):** the `ready` manifest field (default false), the claim-path eligibility filter on it, the mark-ready tool, the new telemetry event, the typed error, the scan default, and the `/crew:ready` operator skill (list + toggle).

**Does NOT build (deferred):** proposing/creating new backlog items from a plain-language feature (Story 9.2 — the author seam); ordering/sequencing the backlog (Story 9.5 — the dashboard renders order); any automated blessing — the judge panel (9.3) and Quality Lead (9.4) are what will eventually *set* `ready` instead of the operator. In this story the only thing that sets `ready` is the operator via the tool. Keep the surface to list + toggle; do not add create/reorder here.

### Mirror the existing withdraw pattern (do not reinvent)

`ready` is the polarity-flipped twin of the existing `withdrawn` flag. The withdraw path is the template for nearly every piece of this story:

- **Manifest field:** the schema already carries an orthogonal operator boolean (`withdrawn`). Add `ready` immediately alongside it, same shape, defaulting `false`. It is **not** a `status` enum value and must never trigger a state-directory move — `status` stays vertical (`to-do → in-progress → done`); `ready` and `withdrawn` are horizontal operator overrides.
- **Toggle tool:** mirror the existing `markWithdrawn` MCP tool — same argument shape (target repo root + the item reference + the boolean), same managed write path, same not-an-eligible-item guard. Name it analogously (e.g. `markStoryReady`).
- **Claim filter:** the claim path already filters out withdrawn items and filters in dependency-ready ones. Add `ready` to that same eligibility predicate. The candidate object the claim path builds must carry the `ready` value through from the parsed manifest, exactly as it already carries dependency-readiness.
- **Skill:** mirror the shape of an existing read-then-act crew skill for the list + toggle UX.

### The two surfaces and where they change

**The field + the filter (the load-bearing half):**
- Add `ready: z.boolean().default(false)` to the execution-manifest schema, immediately after the existing `withdrawn` field, additive and strict-compatible.
- In the claim path, extend the eligibility predicate so a candidate is eligible only when it is both dependency-ready and `ready`. Carry `ready` onto the claimable-candidate object built from each parsed manifest (the same place dependency-readiness is computed).
- In the scan compose step, the new field defaults to `false` for freshly written manifests — confirm the default flows through rather than being dropped on write.

**The tool + the skill (the operator half):**
- New tool: read the named backlog manifest, set `ready`, write it back through the managed write path, leave `status` and the state directory untouched; no-op if the flag already holds the requested value; typed error if the reference is not an un-claimed backlog item.
- New telemetry variant for the toggle; emit exactly once per real change.
- New skill `/crew:ready`: list backlog items with readiness + dependency state, and call the tool to flip a chosen one. UX in the skill; the gate is the tool.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/tools/mark-story-ready.ts` — the toggle tool (mirror `mark-withdrawn.ts`).
- `plugins/crew/mcp-server/src/tools/__tests__/mark-story-ready.test.ts` — AC3, AC4.
- `plugins/crew/skills/ready/SKILL.md` — the operator skill (AC6).

**UPDATE:**
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — add the `ready` field beside `withdrawn` (AC2).
- `plugins/crew/mcp-server/src/tools/list-claimable-todos.ts` — add `ready` to the claimable-candidate interface and populate it from the parsed manifest.
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` — extend the eligibility filter to require `ready` (AC1).
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — ensure the scan compose default writes `ready: false` (AC5).
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — add the readiness event variant additively (AC4).
- `plugins/crew/mcp-server/src/tools/register.ts` — register the new tool with the `DomainError` envelope (AC7).
- `plugins/crew/mcp-server/src/errors.ts` — add the typed not-an-eligible-item error (mirror the withdraw tool's error).

### Existing seams to wire into (do not reinvent)

- **Withdraw tool + field:** `mark-withdrawn.ts` and the `withdrawn` field in `execution-manifest.ts` are the binding template for the tool, the field, the managed write, and the guard.
- **Claim path:** `claimNextStory` in `claim-next-story.ts` (the eligibility filter) and `listClaimableTodos` in `list-claimable-todos.ts` (the candidate object). The drain calls `claimNextStory` via the CLI shim, so the filter is the single chokepoint.
- **State machine:** the atomic-rename transition helper in `state/manifest-state-machine.ts` owns state moves. This story must **not** touch it — `ready` is a field flip, not a transition.
- **Telemetry:** the discriminated event union in `schemas/telemetry-events.ts` and the `logTelemetryEvent` helper in `lib/logger.ts` (mirror an existing one-event emit).
- **Registration + skill shape:** `tools/register.ts` (the `getStatus` registration is a minimal example) and an existing `skills/<name>/SKILL.md` (frontmatter `name`/`description`/`allowed_tools`; body invokes the tool by name; a status/list read first).

### Edge cases worth surfacing in dev/review

- **Default-closed safety.** The whole point of the brake is fail-closed: a brand-new or just-scanned backlog must claim nothing until blessed. A reviewer might flag "the drain claims nothing" — that is correct on an un-blessed backlog; AC1/AC5 pin it.
- **`ready` and `withdrawn` are independent.** A withdrawn item is never claimable regardless of `ready`; a not-ready item is never claimable regardless of deps. Keep the two flags orthogonal and let withdraw win (an item can be both, and must stay unclaimable).
- **No status coupling.** Do not model `ready` as a status value or a new state directory — that would entangle it with the rename state machine and the done-detection the claim path relies on. It is a flat boolean.
- **Idempotent toggle across process boundaries.** The no-op check reads the persisted flag, so a fresh CLI invocation and the drain see the same answer. A re-toggle to the same value writes nothing and emits nothing.
- **Round-trip stability.** Writing the flag must not reorder or reformat the rest of the manifest — mirror whatever serialization the withdraw write uses.

### Risk + build notes (drain context)

- This is a **medium**-risk change: it edits the live drain's claim filter. The change is additive and default-closed, but because it gates real orchestration, expect the auto-merge gate to **pause for a human merge** — that is the intended outcome for this story, not a failure. Until this lands and the operator blesses items, a drain on a freshly scanned backlog will correctly report nothing to claim.
- Code change touching tool + schema + claim + telemetry seams: rebuild and commit `dist/` in the same change; run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. Keep the diff scoped to the files above.
- Do not write or edit the backlog ledger or any state file outside the managed tool path — the tools own that surface. The only manifest this story's code writes is the one the operator toggles, through the managed write path.

### References

- Epic 9 framing, the two-gate architecture, and the readiness-brake spine: the Epic 9 epic file and the design note `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md` (gate 1 vs gate 2; `ready` distinct from "exists in the backlog").
- Withdraw precedent (the binding template): `markWithdrawn` tool + the `withdrawn` manifest field + the claim-path filter that already honours it.
- Deterministic-seam discipline (the load-bearing decision — readiness — lives in the manifest field and the claim filter, not in skill prose): the project's standing principle.
