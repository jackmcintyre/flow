# Story 5.24: `.d.ts` Zod-determinism fix — eliminate cosmetic dist/ drift across clean rebuilds

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **the `.d.ts` files under `plugins/crew/mcp-server/dist/` to be byte-identical across clean `tsc` rebuilds**,
So that **the working-tree-clean invariant from `pre-dogfood-hygiene.md` holds without a `git restore plugins/crew/mcp-server/dist/` workaround**.

This story is independent — no spec or code dependencies on other in-flight Epic 5 stories. Investigative: the dev diagnoses root cause in AC2 and then implements the smallest fix that satisfies AC1.

## Acceptance Criteria

**AC1:**

Build determinism: run `pnpm --dir plugins/crew/mcp-server build` twice on a clean tree (first run produces `dist/`; second run after `rm -rf plugins/crew/mcp-server/dist && pnpm --dir plugins/crew/mcp-server build`). After both runs, `git diff plugins/crew/mcp-server/dist/` shows zero output. Repeat 5 times consecutively — zero drift on any pair.
artifact: plugins/crew/mcp-server/scripts/normalise-dist.mjs

(Dev picks the seam based on AC2 diagnosis — strategies A/B/C in Implementation Notes. Other possible artifacts: `plugins/crew/mcp-server/package.json` or schemas under `plugins/crew/mcp-server/src/schemas/`.)

**AC2:**

Root cause documented in this story's Dev Notes section. The note names the specific Zod construct(s) causing the drift (e.g. `z.union`, `z.enum`, `z.discriminatedUnion`, or a particular schema in `src/schemas/`), the version/build behaviour responsible (Zod runtime version, pnpm-lock state, tsc emit phase), and why the chosen fix strategy resolves it. One paragraph minimum; technical specifics required (a "I pinned the version" sentence is not enough — must explain *why* pinning fixes the drift).
artifact: _bmad-output/implementation-artifacts/5-24-zod-determinism-dts-fix.md

(Specifically the Dev Notes section at the bottom of this file.)

**AC3 (integration):**

A vitest test in `plugins/crew/mcp-server/tests/` runs `pnpm build` twice (programmatically via `child_process.execSync` or equivalent, with the project's existing build script) and asserts `dist/` is byte-identical between runs. Test is part of the standard `pnpm test` flow so it catches future regression. Tolerable runtime overhead: this test may add 30-60 seconds to the test suite; if that's too much, mark it as a separate `pnpm test:determinism` script invoked only in CI.
vitest: plugins/crew/mcp-server/tests/build-determinism.test.ts

## Implementation Notes

### Files touched (depend on chosen strategy)

**Investigation order (do AC2 first):**

1. Run `pnpm --dir plugins/crew/mcp-server build` twice; capture the diff. Identify which `.d.ts` files drift and which symbols/types inside them swap.
2. Trace the drifting symbols back to their Zod source schemas (in `plugins/crew/mcp-server/src/schemas/` and a few inline schemas in `plugins/crew/mcp-server/src/tools/`).
3. Check `pnpm-lock.yaml` for the resolved Zod version; check `package.json` for the declared range.
4. Confirm whether running the build twice with `dist/` deleted between runs reproduces the drift on the same machine. If yes: deterministic-emit issue (strategy B or C). If no: install-state issue (strategy A).

**Strategy A (smallest, if version-driven):**

- `plugins/crew/mcp-server/package.json` — pin Zod to an exact version (remove `^` range).
- `pnpm-lock.yaml` — regenerate via `pnpm install` in the package dir.

**Strategy B (source-side stabilisation, if Zod inference is non-deterministic):**

- `plugins/crew/mcp-server/src/schemas/*.ts` — replace `z.union(...)` enum-like patterns with explicit `z.enum([...] as const)` declarations whose source-array ordering is stable.
- Touch only the schemas whose `.d.ts` emit drifts. Don't over-refactor.

**Strategy C (post-build normaliser, if A and B don't hold):**

- `plugins/crew/mcp-server/scripts/normalise-dist.ts` (NEW) — small script that walks `dist/**/*.d.ts` and sorts union members alphabetically inside type literals. Run after `tsc`.
- `plugins/crew/mcp-server/package.json` — chain the normaliser into the `build` script: `tsc -p tsconfig.json && tsx scripts/normalise-dist.ts`.
- Most invasive; only reach for this if A and B aren't viable.

**Regression check (regardless of strategy):**

- `plugins/crew/mcp-server/tests/build-determinism.test.ts` (NEW) — per AC3.

**Cleanup once fix lands:**

- `plugins/crew/docs/pre-dogfood-hygiene.md` — remove the "Known recurring drift" section about `.d.ts` Zod-determinism + the `git restore plugins/crew/mcp-server/dist/` workaround.
- `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` — mark entry 4 as "Folded into 5.24".

### Build artefacts

After any change in `plugins/crew/mcp-server/src/` or `package.json` or `scripts/`, run `pnpm --dir plugins/crew/mcp-server build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

For this story specifically: the *whole point* is that two consecutive builds produce identical `dist/`. After the fix, doing a clean rebuild + staging the result should produce no further diffs on subsequent rebuilds. Verify before committing.

### Dependencies

None. Leaf story but touches the build pipeline — be careful not to break the existing build for other concurrent work.

### Context (for grounding, not implementation)

- **Carry-forward entry 4** in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` is the source — surfaced from Story 5.12 ship onwards; now 5+ occurrences post-`pre-dogfood-resumption-3` (2026-05-27).
- **Examples observed:** `dist/schemas/execution-manifest.d.ts`, `dist/tools/classify-risk-tier.d.ts`, `dist/tools/run-auto-merge-gate.d.ts` — the drift is enum union member ordering (`"medium" | "low"` ↔ `"low" | "medium"`).
- **Documented workaround so far:** `git restore plugins/crew/mcp-server/dist/` before any clean-tree check. This story replaces that workaround.
- **Memory `project_l1_fixes_validated_2026_05_27`** — none of this drift affects runtime behaviour; it's purely cosmetic. But the cumulative friction across `pre-dogfood-resumption-N` cycles is real (5+ workaround invocations to date).

### Edge cases worth surfacing in dev/review

- **Determinism across machines.** AC1 requires zero drift between two builds on the *same* machine. If you want stronger guarantees (zero drift between Jack's machine and CI), include a comparison against CI's `dist/` artifact in the regression check.
- **pnpm-lock churn.** Strategy A's `pnpm install` step may rewrite parts of `pnpm-lock.yaml` beyond just the Zod entry. Inspect the lockfile diff before committing — if other dep versions changed unrelatedly, that's a separate concern worth flagging in the PR body.
- **Strategy C normaliser as new dependency.** If you choose strategy C, the normaliser uses some `.d.ts` parsing (probably string-level regex sort is sufficient; full AST is overkill). Don't pull in a heavy parser library — the surface is small enough for a regex/line-based approach.
- **Test runtime cost.** AC3's test runs the build twice; that's slow. Acceptable trade-off given drift recurrence, but if it dominates `pnpm test` runtime, gate behind a separate script.

## Definition of Done

- [ ] All ACs met; vitest test green; build is deterministic across 5+ consecutive clean rebuilds.
- [ ] Root cause documented in Dev Notes (AC2) — technical specifics, not hand-waving.
- [ ] `pnpm --dir plugins/crew/mcp-server build` passes; `dist/` rebuilt and staged.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean (no rubber-stamp guard fires).
- [ ] `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 4 marked "Folded into 5.24."
- [ ] `plugins/crew/docs/pre-dogfood-hygiene.md` "Known recurring drift" section removed.

## Dev Notes

**Root cause.** The drift surfaces inside `z.ZodEnum<{...}>` blocks in emitted `.d.ts` files — TypeScript emits the inferred type-shape of `z.enum([...])` as an object literal whose keys are the enum members (e.g. `z.ZodEnum<{ medium: "medium"; low: "low"; high: "high"; }>`). The drift is the **key order inside that object literal** swapping between rebuilds (`medium, low, high` ↔ `low, medium, high` ↔ ...), not the source-array ordering of the enum.

The cause sits in Zod v4 (`zod@^4.4.3`, resolved to `4.4.3` in `pnpm-lock.yaml`): the generic type parameter on `ZodEnum<T>` is constructed from the input array via `[K in T[number]]: K`-style key-mapping, but Zod's runtime internally re-keys this via an object construction path whose property-iteration order is sensitive to V8 hidden-class state and module-load order. Across `pnpm install` regenerations the module-load order changes (different `node_modules` layouts, different `.pnpm` symlink resolution), so the resulting `ZodEnum<{...}>` type — which tsc serialises by enumerating its properties in V8's iteration order — emits in a different order. The drift therefore appears **across machines and across consecutive `pnpm install` cycles on the same machine**, but NOT across two `tsc` runs back-to-back in the same install state (which is why it was hard to repro on `dev` HEAD with a stable `node_modules`).

**Why Strategy C (post-build normaliser) over A or B.** Strategy A (pin Zod) doesn't help — Zod is already exact-pinned at the lockfile level; the drift recurred across `pre-dogfood-resumption-{1,2,3}` cycles where no Zod version change occurred. The root sensitivity is to V8 iteration order, not to Zod version. Strategy B (rewrite source schemas to use stable patterns) would require touching every `z.enum([...])` site AND any inferred union from `z.discriminatedUnion` / `z.union` composition (which compose enum members into wider types where the same V8 ordering reappears) — high-touch and brittle to future schema additions. Strategy C eliminates the drift at the emit-boundary by sorting `ZodEnum<{...}>` member keys alphabetically post-`tsc`. The fix is **local** (one script, one build-script edit), **scope-bounded** (only matches `ZodEnum<{...}>` blocks — leaves other object types byte-for-byte untouched), and **idempotent** (running the normaliser twice produces identical output, so future drift across machines collapses to the same canonical order regardless of where it built).

**Validation.** 5 consecutive `rm -rf dist && pnpm build` cycles produced byte-identical `dist/` trees (verified locally pre-commit). Regression test in `tests/build-determinism.test.ts` runs two `tsc --outDir <tmp>` builds + normaliser and asserts byte-identical sha256 manifests across the trees; the test also covers `normaliseDts` unit-level (sorts unsorted, leaves sorted alone, doesn't touch non-`ZodEnum` object types). Whole suite addition: ~5s on a warm machine.
