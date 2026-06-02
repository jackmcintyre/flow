# Operator runbook — native cutover (native-primary, BMad ingest-only)

> **Goal:** flip the repo's live planning substrate from BMad to **native**
> (the owned, strict, Tier-0-enforced format), reconcile the live backlog onto
> native state, and confirm the board and the drain run on native — **without
> stranding any un-migrated work**.

This runbook is the deliberate operator procedure for Story 10.6. The mechanism
(adapter resolution flips on a config field; the board and claim paths are
already adapter-agnostic) is proven by tests on fixtures. Flipping crew's own
`.flow/config.yaml` is an operator act done **only when the backlog is reconciled** —
the code change and its tests can merge ahead of the live flip.

## Why this is safe to do (and where it stops being reversible)

- **The cutover is one config line.** `resolveWorkspace`
  (`mcp-server/src/state/workspace-resolver.ts`) reads the `adapter:` field of
  `.flow/config.yaml`. Setting it to `native` binds the native adapter; setting
  it back to `bmad` restores BMad as the live adapter. Both adapters stay
  registered and coexist (`mcp-server/src/adapters/registry.ts`) — native is
  **additive**, not a replacement.
- **The board and claim paths don't care about the ref format.**
  `getBacklogDashboard` → `readBacklogInventory` reads `.flow/state/**` and
  `.flow/native-stories/` uniformly; `claimNextStory` reads `.flow/state/to-do/`
  and applies the readiness brake. A `native:<ULID>` ref is read identically to a
  `bmad:<epic>.<story>` ref.
- **The BMad parser is demoted, not removed.** After cutover it remains an
  **ingest on-ramp** (Story 10.5): you can still ingest fresh BMad prose into
  native. It is just no longer the *live* backlog.
- **Reversibility window.** The flip is fully reversible (flip the config back)
  **until native-only work accumulates** — i.e. until new stories are authored
  directly as native and/or drained on the native pipeline. Past that point a
  revert to BMad would strand the native-authored work the same way a premature
  flip would strand un-migrated BMad work. **Treat the flip as a one-way door
  once the first native-authored story is claimed or merged.**

## The cutover steps

Do these in order. Do **not** flip the config (step 3) until step 2 reports a
clean reconciliation.

### 1. Ingest the live BMad backlog into native

Run the one-off, one-way ingest (Story 10.5) over the live BMad backlog. It reads
each `bmad:*` story, enriches it to the native §3 shape, gates each draft on the
Tier-0 validator, writes the survivors to `.flow/native-stories/<ULID>.md`, and
returns a **fix-up report** for any story it could **not** enrich to clear Tier-0.

The ingest is non-destructive: it never mutates or deletes a source BMad story,
and re-running it skips already-ingested stories (dedupe by the recorded source
`bmad:<ref>` provenance) rather than duplicating them.

### 2. Reconcile fix-ups — the gate on the flip

This is the step that prevents stranding work. The pre-mortem failure mode is:
*the flip happens with an incompletely-ingested backlog, and in-flight or
un-migrated BMad stories become invisible to the now-native drain.*

Reconcile against the ingest's fix-up report **before** flipping:

1. **Read the fix-up list.** Every BMad story the ingest could not enrich to
   clear Tier-0 is named there, with the failed Tier-0 check id(s).
2. **Triage every entry explicitly. Nothing is implicitly carried over.** For
   each story on the fix-up list, decide and record one of:
   - **Migrate** — hand-author or fix the native story so it clears Tier-0, then
     re-run the ingest (or write it directly) so it lands in
     `.flow/native-stories/`.
   - **Retire** — the story is obsolete / superseded; record that it is
     intentionally not migrated.
   - **Defer** — the story stays in the BMad backlog for now; record that it will
     be migrated later, and accept that it will **not** be visible to the native
     drain until it is.
3. **Verify the reconciliation count.** Confirm the native-stories directory is a
   complete superset of the work the team still needs to be *live*: every BMad
   story that is not explicitly retired or deferred has a corresponding native
   story. The single assumption that sinks the cutover is assuming this without
   checking — **count it.**
4. **Check for in-flight work.** Any story currently in `.flow/state/in-progress/`
   under a `bmad:` ref is in-flight; let it land (merge or block) before the flip,
   or it is stranded. The flip changes which adapter is *live*; it does not move
   in-flight manifests.

> **Do not proceed to step 3 until every fix-up-list entry is triaged and the
> reconciliation count is verified.** The flip does not strand un-migrated work
> *only because* this step gates it.

### 3. Flip the config

Set the active adapter to native in `.flow/config.yaml`:

```yaml
adapter: native
adapter_config: {}
```

This is the cutover. From here, `resolveWorkspace` binds the native adapter, and
the board and drain operate on native state.

> **Detection ambiguity — why the flip is an explicit config field, not
> detection.** With both `.flow/native-stories/` and a BMad stories tree present,
> auto-`detect()` would match *both* adapters and (correctly) refuse to guess.
> The cutover sidesteps this entirely by writing an explicit `adapter: native`
> config: the resolver takes the config branch and never consults `detect()`. Do
> not rely on detection to pick native — pin it in the config.

### 4. Scan native into the to-do queue

Run `/flow:scan`. The native adapter projects each `.flow/native-stories/<ULID>.md`
into an execution manifest under `.flow/state/to-do/`. Scan is idempotent and
fail-closed: a native story that cannot parse / clear Tier-0 is loudly warned and
**not** projected (never silently dropped) — fix the source and re-scan.

### 5. Bless the stories you want claimable

Scanning lands stories in `to-do/` as **not ready**. The readiness brake
(Story 9.1) is fail-closed: the drain claims nothing until you bless it. Use
`/flow:ready` to mark each story you want the drain to pick up as `ready: true`.

### 6. Verify the board and the drain run on native

This is the proof that the live pipeline runs end-to-end on native:

- **Board:** run `/flow:board`. It should render the backlog **grouped by epic
  from native state**, with each blessed native story shown **claimable** and
  each un-blessed one **not claimable**. (Native refs that carry an
  `<epic>.<story>` source id group by epic exactly as BMad refs do; ULID-only
  refs fall into the `(no epic)` bucket.)
- **Drain claim:** the claim path (`claimNextStory`) claims a **blessed native
  `ready`** story (readiness brake + dependencies honored) and **never** an
  un-blessed one. The BMad authoring/scan path is no longer the live backlog.

When the board renders from native state and the drain claims a native story, the
cutover is complete: the live cockpit operates on native.

## Reversibility note

Until native-only work accumulates (step 6 onward), the flip is reversible: set
`adapter: bmad` back in `.flow/config.yaml` and BMad is the live adapter again,
with the BMad backlog live. Both adapters remain registered, so nothing is lost
by reverting. **Once the first native-authored or native-drained story is in
flight or merged, treat the cutover as a one-way door** — reverting would strand
the native work, mirroring the un-migrated-BMad strand this runbook's
reconciliation step exists to prevent.
