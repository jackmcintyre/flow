# Story 9.5: Generated backlog dashboard

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **the outstanding backlog rendered as grouped tables from live state**,
So that **I read one always-true view — by epic, with status and readiness — instead of maintaining a table by hand**.

This is the cockpit's **read surface**, and it closes the loop on the original "build the tables" ask: the grouping tables are **generated from state**, not hand-kept. It reads the backlog the same way the rest of the plugin does (the backlog-inventory enumeration over the state directories), groups entries by epic, and shows each item's status and its **readiness** (the Story 9.1 flag) so the operator can see at a glance what is blessed, what is waiting, and what is claimable. It is **read-only** — pure rendering over a state read, mirroring the plugin's existing getter/`render*` separation (a pure render function, no IO, no clock).

## Dependencies

- **Reuses the backlog-inventory read** (the existing enumeration of the state directories + native-source-only entries) and the pure `render*` helper pattern (e.g. the status renderer).
- **Reads Story 9.1's `ready` flag** to show readiness/claimability per item.
- Read-only: depends on nothing it mutates.

## Acceptance Criteria

**AC1 — the dashboard renders the backlog grouped by epic from live state (integration):**

Given a set of backlog manifests across the state buckets, the dashboard groups entries by epic and lists each item with its state, derived from the live inventory read — not a hand-maintained list. A vitest seeds manifests spanning multiple epics and states, renders the dashboard, and asserts the output groups the items by epic with each item's state shown.
vitest: plugins/crew/mcp-server/src/tools/__tests__/backlog-dashboard.test.ts

**AC2 — readiness and claimability are shown per item (integration):**

Each item shows whether it is blessed (the readiness flag) and whether it is claimable (dependencies satisfied and blessed); a not-ready item is visibly distinct from a ready one. A vitest seeds a ready item and a not-ready item with satisfied dependencies and asserts the rendered rows distinguish them on readiness and claimability.
vitest: plugins/crew/mcp-server/src/tools/__tests__/backlog-dashboard.test.ts

**AC3 — the render is a pure function of state (integration):**

The dashboard renderer takes a typed inventory snapshot and returns text with no file IO and no clock dependency, mirroring the existing pure renderers; the state read is a separate getter. A vitest calls the renderer twice with the same snapshot and asserts byte-identical output, and asserts the renderer performs no IO (pure-function contract).
vitest: plugins/crew/mcp-server/src/tools/__tests__/backlog-dashboard.test.ts

**AC4 — blessing an item changes the rendered view with no hand-edit (integration):**

Because the table is a function of state, marking an item ready (through the brake tool) and re-reading the inventory yields a dashboard whose row for that item now reads ready/claimable — no manual table edit. A vitest renders the dashboard, flips an item via the brake tool, re-reads + re-renders, and asserts only that item's readiness/claimability changed.
vitest: plugins/crew/mcp-server/src/tools/__tests__/backlog-dashboard.test.ts

**AC5 — a read-only skill prints the dashboard (artifact):**

A skill renders and prints the dashboard for the operator. Its frontmatter lists only read-tools in `allowed_tools`; its body mutates nothing. The file exists at the skill path and is shaped like the other crew skills.
artifact: plugins/crew/skills/board/SKILL.md

## Definition of Done

- [ ] All five ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new test file covers every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC4 runnable vitest, AC5 file-presence.
- [ ] The renderer is pure (no IO, no clock); the state read is a separate getter — mirrors the existing render pattern.
- [ ] Read-only: the dashboard mutates no state.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** a pure `renderBacklogDashboard` over the inventory snapshot (group-by-epic + status + readiness/claimability), and a read-only `/crew:board` skill.

**Does NOT build:** operator-set priority/sequencing (deferred — the dashboard orders by natural ref order for now; an explicit operator order field is a later concern, not this slice's spine); any state mutation (read-only); the readiness flag itself (Story 9.1).

### Wire existing machinery (do not reinvent)

- **State read:** the backlog-inventory reader already enumerates the state directories and (on the native adapter) native-source-only entries, returning typed entries with ref, title, state, and withdrawn. Reuse it; if readiness/claimability aren't already projected onto the entry, extend the entry projection additively (read the manifest's `ready` + `depends_on`).
- **Pure render pattern:** mirror the existing getter/`render*` split (the status report + its pure renderer) — the data read is impure, the render is a pure function of the snapshot. This is the project's standing pattern for surfaces (and what makes the render unit-testable).
- **Epic grouping:** derive the epic from the entry ref (the `<epic>.<story>` shape) or the manifest; group and order naturally.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/tools/render-backlog-dashboard.ts` — the pure renderer (+ a thin getter wrapper if needed).
- `plugins/crew/mcp-server/src/tools/__tests__/backlog-dashboard.test.ts` — AC1–AC4.
- `plugins/crew/skills/board/SKILL.md` — the read-only skill (AC5).

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/read-backlog-inventory.ts` — if needed, project `ready` + claimability onto the inventory entry (additive).
- `plugins/crew/mcp-server/src/tools/register.ts` — register the dashboard getter if it is exposed as a tool.

### Existing seams to wire into (do not reinvent)

- **Inventory:** `readBacklogInventory` in `plugins/crew/mcp-server/src/tools/read-backlog-inventory.ts` (state-dir enumeration + entry shape).
- **Render pattern:** the pure `renderStatus` in `plugins/crew/mcp-server/src/tools/get-status.ts` (getter/renderer separation, no IO in render).
- **State names:** `STATE_NAMES` in `plugins/crew/mcp-server/src/state/manifest-state-machine.ts`.
- **Readiness/claimability:** the `ready` field (Story 9.1) and the claim eligibility (deps + ready) — show both.

### Edge cases worth surfacing in dev/review

- **Empty backlog renders cleanly.** A backlog with no items (or an epic with none) renders an empty/"nothing here" view, not a crash.
- **Ready ≠ claimable.** An item can be ready but blocked on an unsatisfied dependency — show readiness and claimability as distinct columns, or the operator misreads a blocked item as buildable.
- **Generated, never hand-edited.** The dashboard is output; if anyone is tempted to hand-edit it, that is the old failure mode the cockpit replaces. Surfacing it as a printed view (not a checked-in file) keeps it honest.

### Risk + build notes

- **Low** risk: read-only, additive, pure render + a getter. Should classify low and (once the auto-merge gate trusts low) merge without a human pause. Rebuild + commit `dist/`; full build + test green before PR.

### References

- The original "build the tables" ask and why they should be generated, not hand-kept: the design note `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md` §4 (the grouping tables become a generated view of intake state).
- Inventory + render precedents: `read-backlog-inventory.ts`, `get-status.ts` (`renderStatus`).
- Story 9.1 (the readiness flag this surfaces).
