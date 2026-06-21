# Story 3.4: Native adapter, planner subagent, and `/plan` skill

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator without a planning tool**,
I want **to open `/crew:plan` and produce conforming native-adapter story files from a free-form intent conversation**,
so that **I can prime a backlog without adopting a separate planning tool, while users already on BMad are pointed back at BMad's own authoring skills.**

### What this story is, in one sentence

Ship the three pieces that turn the `native` adapter from "scaffold" into a real planning surface: (1) a `NativeAdapter` registered alongside `BmadAdapter` in `mcp-server/src/adapters/registry.ts` that reads `<target-repo>/.crew/native-stories/<ref>.md` files and normalises them to the same `SourceStory` shape Story 3.3 produces for BMad; (2) a `planner` subagent prompt + `permissions/planner.yaml` allowlist that runs an LLM-driven planning conversation and writes story files under that path; and (3) the `/crew:plan` slash-command skill at `plugins/crew/skills/plan/SKILL.md` that routes — for `adapter: native` it spawns the planner subagent via `Task`; for `adapter: bmad` it prints a pointer at `/bmad-create-story` and offers a follow-up `/crew:scan` pass.

### What this story fixes (and why it needs its own story)

Stories 3.1–3.3 land the adapter contract, registry, execution-manifest layer, `scan-sources`, and the BMad reference adapter. None of them give the user a way to *author* stories from inside the crew plugin. The native adapter currently does not exist; `/crew:plan` does not exist; the `planner` catalogue role exists at `plugins/crew/catalogue/planner.md` and `permissions/planner.yaml` exists with a minimal allowlist, but no skill spawns it. This story closes that loop end-to-end for the "no planning tool" persona, and routes the "BMad already in use" persona back at BMad without trying to author on their behalf. After this story lands, a non-engineer on a greenfield repo can run `/crew:plan`, talk through their intent, and walk away with native-adapter story files that `scan-sources` will pick up on the next pass.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Re-define the `PlanningAdapter` interface, `SourceStory` shape, or the execution-manifest schema — those are owned by Stories 3.1 and 3.2.
- (c) Re-implement `scan-sources` or rewrite the manifest writer — the `/crew:plan` skill's BMad branch calls `scanSources` via the existing MCP tool; the native branch produces source files only and lets a separate `/crew:scan` run materialise manifests.
- (d) Implement planning-discipline enforcement (state-mutating story requires integration AC, implicit `depends_on` detection, ship-gate refusal). Those are Story 3.5's job. The planner subagent in this story produces stories at the body-shape level; discipline enforcement is layered on later via `validateAgainstDiscipline()`.
- (e) Implement the re-open / discard-a-feature flow. That's Story 3.6. This story's `/crew:plan` may be re-invoked safely (subsequent runs simply spawn the planner again against the same backlog), but no add/edit/discard affordance is built here.
- (f) Implement the plain-language guideline guardrail or hand-edit refusal. That's Story 3.7.
- (g) Author the dev session, the dev subagent, or any code-implementing skill. The planner produces story files; nothing in this story implements stories.
- (h) Mutate the `team/` directory, the `catalogue/`, or any persona-knowledge file. The planner subagent is invoked from the catalogue prompt at `plugins/crew/catalogue/planner.md`; this story may **extend** that catalogue prompt with explicit planning-conversation steps but MUST NOT introduce hiring or persona-knowledge writes.
- (i) Touch the BMad adapter's parser, fixtures, or status-mapping code. The BMad branch of `/crew:plan` is a thin pointer skill; it does not call any BMad-adapter method beyond what's already exposed via MCP.
- (j) Build the `risk_tier` classifier (FR40a). The planner subagent prompts the user for a risk tier on each story manually; automatic classification is a separate v1 architecture deliverable.

---

## Acceptance Criteria

> **Verbatim from epic** for AC1–AC5, with the user-surface tags applied per `plugins/crew/docs/user-surface-acs.md`. AC6 is an additional deterministic content-structure check on the slash-command skill file itself, added per the spec-author's brief and tagged user-surface because it references a path the install/README docs name when discoverability matters.

**AC1 (user-surface):**
**Given** a target repo with `adapter: native` configured,
**When** I run `/crew:plan`,
**Then** the planner subagent opens a conversation, interprets my intent, and produces story files at `<target-repo>/.crew/native-stories/<ref>.md` following the native-adapter body shape (`## Narrative`, `## Acceptance Criteria`, `## Implementation Notes`, `## Dependencies`). _(FR1, FR2, FR12)_
<!-- User-surface: names the slash-command literal `/crew:plan` (rubric i) AND a file path `<target-repo>/.crew/native-stories/<ref>.md` that the README / install docs MUST instruct the operator to expect, since they will read or edit those files between planning and the next `/crew:scan` (rubric iii). -->

**AC2 (user-surface):**
**Given** a target repo with `adapter: bmad` configured,
**When** I run `/crew:plan`,
**Then** the skill points me at BMad's own authoring skills (`/bmad-create-story` etc.) and offers a `scanSources` pass to pick up newly authored stories. _(Architecture §Native adapter)_
<!-- User-surface: names two slash-command literals — `/crew:plan` and `/bmad-create-story` — both of which the operator types verbatim into Claude Code (rubric i). The "offers a scanSources pass" half is observed in the chat as a prompt the operator answers. -->

**AC3:**
**Given** a planner-produced native story,
**When** it is validated,
**Then** it parses against the native-story schema and produces a normalised `SourceStory` identical in shape to the BMad adapter's output. _(FR3, FR13)_
<!-- Not user-surface: AC3 governs an internal Zod schema and the `SourceStory` TypeScript shape produced by `NativeAdapter.listSourceStories()` / `readSourceStory()`. No CLI literal, slash command, copy-by-name path, or Claude Code UI element is named. The operator never observes the schema directly — only its consequences via `/crew:scan` output, which AC1 / AC5 cover. -->

**AC4 (user-surface):**
**Given** a planner conversation,
**When** the user describes a feature in vague terms,
**Then** the planner produces ACs at the user-value level (what the user *does*), not implementation level. _(FR4)_
<!-- User-surface (judgement call): AC4 does not name a slash-command literal or file path directly, but the planner subagent is itself a Claude Code UI surface — the operator reads its messages and the generated story body in chat, and the AC governs observable conversational output, not an internal data structure. Per `plugins/crew/docs/user-surface-acs.md` rubric (iv) — "any Claude Code UI element the user is expected to observe" — the planner's natural-language output qualifies. Tagged user-surface so the pre-PR gate forces evidence that a real planning conversation was driven (either automated by a test that asserts AC text-quality regex, or operator-pasted verbatim Claude Code output of a planning run). -->

**AC5 (integration):**
vitest drives a scripted planning conversation against a fixture and asserts the resulting native-story files parse and reconcile via `scan-sources`.

**AC6 (user-surface):**
**Given** the `/crew:plan` skill file at `plugins/crew/skills/plan/SKILL.md`,
**When** the file is inspected,
**Then** its front-matter `name` field is exactly `crew:plan`, its `Steps` section contains a verbatim instruction to spawn the planner subagent via Claude Code's `Task` tool against the catalogue prompt at `plugins/crew/catalogue/planner.md`, and its body explicitly enumerates both routing branches (`adapter: native` → spawn planner; `adapter: bmad` → point at `/bmad-create-story` and offer `/crew:scan`).
<!-- User-surface: AC6 references the install-doc-discoverable skill file path `plugins/crew/skills/plan/SKILL.md` (rubric iii — `plugins/crew/docs/README-install.md` lists skill files by path during the install checkpoint) AND the slash-command surface `/crew:plan` (rubric i). This AC is the deterministic content-structure check called for in the spec brief; it guards against the file existing-but-empty failure mode that no integration test catches if the test harness mocks the skill loader. -->

---

## Behavioural contract

The planner subagent (spawned by `/crew:plan` via `Task`) is LLM-driven; its behaviour is governed by prompt-level invariants. The catalogue prompt at `plugins/crew/catalogue/planner.md` MUST be extended in this story with the following invariants stated in absolute modal language. Every invariant maps to either an AC above or a `does NOT` clause and exists so that future prompt edits can be reviewed against a fixed contract.

- **MUST** produce acceptance criteria at the user-value level — phrased as what the user *does* or *observes* in the running product, never as internal implementation steps, function calls, schema fields, or file edits. _(per AC4 / FR4)_
- **MUST NEVER** write story files anywhere other than `<target-repo>/.crew/native-stories/<ref>.md`. Writing into `<target-repo>/.crew/state/`, into the BMad output tree, into the plugin source tree, or into any other directory under the target repo is forbidden. _(per AC1, does-NOT clause (b)/(c))_
- **MUST**, when invoked against a workspace whose resolved `adapter:` is `bmad`, refuse to author stories itself and instead surface the BMad pointer text and the `/crew:scan` offer. The planner MUST NOT call any native-adapter write path under the BMad branch, regardless of how the user phrases their intent. _(per AC2)_
- **MUST** structure every native-story body file with the four schema sections in this order: `## Narrative`, `## Acceptance Criteria`, `## Implementation Notes`, `## Dependencies`. Other H2 sections are forbidden in v1; additional content belongs inside one of the four. An empty section is permitted (e.g. `## Dependencies` followed by a placeholder line) so the schema parses uniformly. _(per AC1, AC3)_
- **MUST NOT** modify `sprint-status.yaml`, the user's working tree outside `<target-repo>/.crew/native-stories/`, any file inside `.git/`, or any code file anywhere in the repo. The planner is read-only against everything except its own write directory. _(per does-NOT clause (a), (g), (h))_
- **MUST NOT** invoke `scan-sources`, write execution manifests under `.crew/state/`, or transition any manifest's status. The planner produces source-layer files only; materialisation into the execution layer is the user's next step via `/crew:scan`. _(per does-NOT clause (c))_
- **MUST NEVER** enforce planning-discipline rules (state-mutating-needs-integration-AC, implicit-depends-on, ship-gate). Those land in Story 3.5. The planner in this story may *prompt* the user about ACs and dependencies, but MUST NOT refuse to write a story over a discipline violation. _(per does-NOT clause (d))_
- **MUST** yield with the catalogue's locked yield phrase (`"This sits in <role>'s domain — handing off"`) if the user asks for work that falls inside another hired role's domain (security review, docs, debugging). The planner does not silently take on out-of-domain work. _(per existing planner catalogue mandate)_
- **MUST NEVER** call `gh` for anything beyond the allowlisted `pr-view` (read-only). The planner MUST NOT push commits, open PRs, comment on PRs, or change PR labels. _(per `permissions/planner.yaml` allowlist; negative capability)_
- **MUST**, on every story file write, derive `<ref>` as `native:<ULID>` (per Architecture §Native adapter and §Story refs). The ULID MUST be freshly generated at write time and MUST NOT be re-used across story files. The file basename is the bare ULID (e.g. `01JX9....md`); the colonised form (`native:01JX9...`) is reserved for the `ref` field in the parsed `SourceStory`.

The catalogue prompt MUST cite this contract section by file path (`_bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md` § Behavioural contract) in a TSDoc-style `@see` comment or a Markdown footnote so a future prompt-editor can find the source of the invariants.

---

## Tasks / Subtasks

- [ ] **Task 1 — `NativeAdapter` implementation (AC: 1, 3, 5)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/adapters/native/index.ts` exporting a `NativeAdapter` object that satisfies the `PlanningAdapter` interface from `mcp-server/src/adapters/adapter.ts`.
  - [ ] 1.2 `name`: the string `"native"`.
  - [ ] 1.3 `detect(targetRepo)`: return `true` iff the directory `<targetRepo>/.crew/native-stories/` exists AND contains at least one file matching the native-story filename pattern (see 1.6). Otherwise `false`. Permission errors → `false` (do not throw). This mirrors the BMad adapter's detect contract from Story 3.3 Task 2.
  - [ ] 1.4 `defaultConfig()`: return `{}`. The native adapter has no per-repo config in v1; the story directory path is fixed.
  - [ ] 1.5 `adapterConfigSchema`: a Zod schema that accepts an empty object (`z.object({}).strict()`). Reject unknown keys.
  - [ ] 1.6 `listSourceStories()`: walk `<targetRepo>/.crew/native-stories/`. Filename pattern: `^[0-9A-HJKMNP-TV-Z]{26}\.md$` (ULID regex per Crockford's base32 alphabet). Files not matching are skipped silently. No subdirectory recursion.
  - [ ] 1.7 `readSourceStory(ref)`: parse `ref` as `native:<ULID>`. Resolve to `<targetRepo>/.crew/native-stories/<ULID>.md`. Read file, hand to the parser helper (Task 2), return the resulting `SourceStory`.
  - [ ] 1.8 `resolveSourcePath(ref)`: pure function — parse the ULID out of the ref and return the absolute path. No I/O.
  - [ ] 1.9 `validateAgainstDiscipline(story)`: return `story` unchanged (pass-through). Real enforcement lands in Story 3.5; Story 3.4 ships the conformant default per the contract comment in `adapter.ts`.
  - [ ] 1.10 Register `NativeAdapter` in `mcp-server/src/adapters/registry.ts`'s `adapters` array. **Order matters:** append after `BmadAdapter`. The architecture's no-short-circuit rule for `getActiveAdapter()` Branch B means registration order surfaces in `AmbiguousAdapterError.matchingAdapters`; BMad-shaped repos that also happen to contain a `.crew/native-stories/` dir would otherwise resolve ambiguously, but for v1 a BMad repo by convention will not contain native-stories at the same time.

- [ ] **Task 2 — Native-story parser + Zod schema (AC: 3, 5)**
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts` exporting `parseNativeStory(absPath: string, fileContents: string): SourceStory`. Pure (no I/O). Mirrors the structure of `parse-bmad-story.ts`.
  - [ ] 2.2 Native-story body shape (per Architecture §Native adapter and Pattern §2):
    - H1: `# <Title>` (required; throws `MalformedNativeStoryError` if missing).
    - `## Narrative` section: a paragraph in "As a … I want … so that …" form. Body text is the narrative; preserve inline formatting; strip trailing whitespace.
    - `## Acceptance Criteria`: bolded numbered AC blocks (`**AC1:**`, `**AC2 (integration):**`, etc.) each followed by `**Given** … **When** … **Then** …` prose. The numeric prefix is canonical; the parenthetical tag is the kind hint and maps to `AC.kind` ("integration" tag → "integration"; "unit" tag, no tag, or any other tag → "unit"). The user-surface tag is **not** carried into `AC.kind` in this story — `(user-surface)` is metadata for Story 1.8's gate, not a Story 3.x execution-layer concept.
    - `## Implementation Notes`: free-form body. Maps to `SourceStory.implementation_notes` (optional; if section absent or empty, field is `undefined`).
    - `## Dependencies`: bullet list of refs (`- native:01JX9...` or `- bmad:1.2.3`). Maps to `SourceStory.depends_on`. Empty list (or absent section) → `[]`.
  - [ ] 2.3 The parser MUST throw `MalformedNativeStoryError` (new typed error in `mcp-server/src/errors.ts`) for: missing H1, missing `## Narrative`, missing `## Acceptance Criteria`, zero parsable ACs under `## Acceptance Criteria`, an AC block with no `**Given/When/Then**` prose, or a `## Dependencies` bullet that does not parse as a ref. The error message must name the offending file path and the offending section/line.
  - [ ] 2.4 Create `plugins/crew/mcp-server/src/schemas/native-story.ts` exporting `NativeStorySchema` — a Zod schema that mirrors the parser's expectations and is callable from `validate-native-story` (if needed) to round-trip a synthesised story body. The schema is **content-level** (asserts the four sections are present in order); it does not re-validate refs (the parser owns that).
  - [ ] 2.5 `raw_path`: the absolute path passed in. `raw_frontmatter`: `{}` for native stories (no frontmatter shape; the parser may stuff `{ title, ref }` here for traceability but the default is empty per the SourceStory contract's "kept for traceability" note). `source_hash`: sha256 of `fileContents` per Story 3.2's hashing convention; the parser computes it.

- [ ] **Task 3 — Extend the planner catalogue prompt (AC: 1, 4; Behavioural contract)**
  - [ ] 3.1 Edit `plugins/crew/catalogue/planner.md`. Preserve the existing `role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, and `locked_phrases` frontmatter — do not narrow the existing surface area.
  - [ ] 3.2 Replace the existing `## Prompt` section with an extended prompt that:
    - Cites the Behavioural contract section of this story spec by file path in a footnote at the top of the prompt.
    - Walks the planner through a four-step planning conversation: (i) elicit intent in plain language, (ii) propose a candidate set of stories with one-line narratives, (iii) for each accepted story, elicit user-value ACs and dependencies, (iv) on user approval, write each story to `<target-repo>/.crew/native-stories/<ULID>.md` via the `writeNativeStory` MCP tool (Task 4).
    - Enumerates every MUST / MUST NOT / NEVER from the Behavioural contract above, in absolute modal language.
    - States explicitly: the planner is invoked only against `adapter: native` workspaces. If invoked against any other adapter, the planner must refuse and yield with `"This sits in <adapter>'s authoring tools' domain — handing off"`. (The `/crew:plan` skill prevents this from happening in v1, but the prompt-level guard is defence in depth.)
  - [ ] 3.3 Do NOT change `plugins/crew/permissions/planner.yaml`'s tools_allow except to add `writeNativeStory` (the new MCP tool from Task 4) and `heartbeat` if not already present. Confirm `gh_allow: [pr-view]` is preserved.
  - [ ] 3.4 The catalogue prompt body MUST contain the literal string `<target-repo>/.crew/native-stories/` exactly so a grep-based test can assert the path is named in the prompt.

- [ ] **Task 4 — `writeNativeStory` MCP tool (AC: 1, 3)**
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/write-native-story.ts` registering an MCP tool named `writeNativeStory`. Input schema (Zod): `{ targetRepoRoot: string; title: string; narrative: string; acceptance_criteria: Array<{ text: string; kind: "integration" | "unit" }>; implementation_notes?: string; depends_on: string[] }`.
  - [ ] 4.2 Behaviour: resolve the workspace via `resolveWorkspace(targetRepoRoot)`. If the active adapter's `name` is not `"native"`, throw a typed `WrongAdapterError` (new in `errors.ts`) — the tool refuses to write into a non-native workspace. This is the runtime guard that backs the BMad-branch Behavioural-contract clause.
  - [ ] 4.3 Generate a fresh ULID (use `ulid` package, version pinned via `pnpm add ulid` at latest stable). Resolve target path `<targetRepoRoot>/.crew/native-stories/<ULID>.md`. Create the parent directory recursively if absent.
  - [ ] 4.4 Render the file body from inputs in the canonical four-section order. Validate the rendered body by round-tripping it through `parseNativeStory()` before writing; reject (throw) on parser failure so a malformed render cannot reach disk.
  - [ ] 4.5 Write the file atomically (`fs.writeFile` to a sibling `.tmp` path, then `fs.rename`). Return `{ ref: "native:<ULID>", path: "<absolute-path>" }`.
  - [ ] 4.6 Register the tool in `mcp-server/src/tools/register.ts` alongside `scanSources`, `getStatus`, etc.

- [ ] **Task 5 — `/crew:plan` skill file (AC: 1, 2, 6)**
  - [ ] 5.1 Create `plugins/crew/skills/plan/SKILL.md`. Frontmatter: `name: crew:plan`; `description:` one-line: "Open a planning conversation. On native repos, spawn the planner subagent to author stories; on BMad repos, point you at BMad's authoring skills."; `allowed_tools: [Read, Task]`.
  - [ ] 5.2 Body sections to include (mirror the conventions of `plugins/crew/skills/scan/SKILL.md` and `plugins/crew/skills/hire/SKILL.md`):
    - `# What this skill does` — one paragraph naming both routing branches.
    - `# Prerequisites` — a target repo. `.crew/config.yaml` SHOULD be present (auto-detected on first skill invocation via the workspace resolver from Story 1.2). If absent, the skill calls `getStatus` to trigger the resolver and surfaces any adapter-resolution error verbatim.
    - `# Steps` — numbered list:
      1. Identify the target repo root from the current workspace.
      2. Call `getStatus({ targetRepoRoot })` to resolve the active adapter.
      3. Branch on the resolved adapter name.
      4. **`adapter: native` branch:** spawn the `planner` subagent via Claude Code's `Task` tool, with system prompt assembled from `readCatalogue({ role: "planner" })`'s Prompt section verbatim, followed by an `<initial-context>` block carrying the resolved `targetRepoRoot` and the current backlog summary (refs already under `.crew/native-stories/` plus refs already under `.crew/state/to-do/`, both as JSON arrays). The planner subagent runs the conversation; the skill is a thin orchestrator.
      5. **`adapter: bmad` branch:** print a fixed pointer block that names `/bmad-create-story` and `/bmad-edit-prd` as the authoring entry points, and offer the user a follow-up `/crew:scan` pass to materialise newly authored stories into execution manifests. The skill MUST NOT spawn the planner subagent on this branch.
      6. Exit conditions: native branch — the planner subagent emits the catalogue's terminal locked phrase (currently `Handoff to generalist-dev — story <story-id> ready to claim`); BMad branch — the skill exits after the operator types `done` or accepts the `/crew:scan` offer.
    - `# Failure modes` — enumerate: `NoAdapterMatchedError` (fresh repo without source stories — surface verbatim, suggest `/crew:hire` first); `UnknownAdapterError` (config names an unregistered adapter — surface verbatim); `WrongAdapterError` from `writeNativeStory` (programming bug if it ever fires inside the skill, since the routing prevents it; surface for filing).
  - [ ] 5.3 The skill body MUST contain, verbatim, the planner-subagent invocation line. The literal text required by AC6 is: `spawn the planner subagent via Claude Code's Task tool against the catalogue prompt at plugins/crew/catalogue/planner.md`. This is the grep target for the deterministic content-structure assertion.
  - [ ] 5.4 The skill body MUST enumerate **both** routing branches in a single `# Steps` section with the literal strings `adapter: native` and `adapter: bmad` present.
  - [ ] 5.5 The skill body MUST contain the literal slash-command strings `/crew:plan`, `/bmad-create-story`, and `/crew:scan`.

- [ ] **Task 6 — Native-adapter fixtures + vitest integration (AC: 5)**
  - [ ] 6.1 Create `plugins/crew/mcp-server/src/adapters/native/fixtures/.crew/native-stories/` and commit two example native-story files. Use deterministic ULID-shaped basenames (e.g. `01JX9000000000000000000001.md` and `01JX9000000000000000000002.md`) so test assertions can be stable.
  - [ ] 6.2 Each fixture file MUST conform to the body shape from Task 2.2. One MUST declare a `depends_on` ref to the other to exercise dependency parsing.
  - [ ] 6.3 Create `plugins/crew/mcp-server/src/adapters/native/native-adapter.integration.test.ts` (vitest). Suite MUST exercise `detect`, `listSourceStories`, `readSourceStory`, and `resolveSourcePath` against the fixture target repo. Mirrors the structure of the BMad adapter's integration test from Story 3.3.
  - [ ] 6.4 Create `plugins/crew/mcp-server/src/tools/write-native-story.integration.test.ts`. Suite MUST drive a scripted planning conversation (the "scripted" half of epic AC5): the test harness directly calls `writeNativeStory` with a sequence of synthesised story inputs against a tmpdir target repo, then runs `scanSources` against the same tmpdir, then asserts: (a) each native-story file parses via `parseNativeStory`; (b) each yields a `SourceStory` shape-equivalent to the BMad adapter's output (assert key set equality on the returned object); (c) each appears in `.crew/state/to-do/<ref>.yaml` after the `scanSources` pass with `adapter: native`, the correct `source_hash`, and `depends_on` carried through. _(epic AC5)_
  - [ ] 6.5 Add a deterministic structure test at `plugins/crew/mcp-server/src/skills/plan-skill-shape.test.ts` (or co-locate with skill-shape tests if such a file already exists) that loads `plugins/crew/skills/plan/SKILL.md` from disk and asserts: the front-matter `name:` is `crew:plan`; the body contains the verbatim invocation line from Task 5.3; the body contains the literal strings `adapter: native`, `adapter: bmad`, `/crew:plan`, `/bmad-create-story`, and `/crew:scan`. _(AC6)_

- [ ] **Task 7 — Wire-up + documentation (AC: 1, 2)**
  - [ ] 7.1 Update `plugins/crew/docs/README-install.md` to list `/crew:plan` in the slash-command surface table alongside `/crew:scan`, `/crew:hire`, `/crew:status`, etc., with a one-line description.
  - [ ] 7.2 Update `plugins/crew/README.md` (if present) with the same one-liner.
  - [ ] 7.3 Rebuild and commit `plugins/crew/mcp-server/dist/` per the project's "build output is tracked in git" rule (CLAUDE.md §Process notes). CI fails on drift.
  - [ ] 7.4 Confirm `plugins/crew/.claude-plugin/plugin.json` does not need to enumerate skills explicitly (the install path picks up `skills/*/SKILL.md` automatically per existing convention). If it does enumerate them, add `plan`.

---

## Architecture compliance

- `PlanningAdapter` interface from `mcp-server/src/adapters/adapter.ts` is the binding contract. `NativeAdapter` MUST satisfy every method including `defaultConfig`, `adapterConfigSchema`, and `validateAgainstDiscipline` (pass-through in this story per the interface's TSDoc).
- The `SourceStory` shape from the same file is the binding output contract. `parseNativeStory` MUST produce `SourceStory` objects key-equivalent to `parseBmadStory`'s output so downstream consumers (`scanSources`, dev loop, retro analyst) are adapter-agnostic. AC3 + the AC5 integration test guard this.
- Story refs are `native:<ULID>` per Architecture §Story refs. ULID is generated at write time (Task 4.3), is the stable identifier, and survives a tool switch.
- The execution manifest layer is NOT touched by this story. The planner writes source-layer files; `scanSources` (Story 3.2) is what materialises manifests. This split is load-bearing — keep it.
- Adapter registration order in `registry.ts` (BMad first, native second) is load-bearing for `getActiveAdapter()` Branch B ambiguity reporting. See `registry.ts` lines 38–78 for the contract.
- Planning-discipline enforcement is explicitly out of scope per `does NOT` (d). The `validateAgainstDiscipline()` pass-through default from the interface stands. Story 3.5 will replace it.

## Library / framework requirements

- **`ulid`** — newest stable from npm at implementation time. Pin via `pnpm add ulid -F crew-mcp-server` (or the workspace-equivalent invocation that the existing MCP server uses for its deps). Used by Task 4.3 only. Per the user-memory rule on dependency versions: let pnpm resolve, then pin; do not guess a version from training data.
- **`zod`** — already a dep of the MCP server (see `mcp-server/src/schemas/*.ts`). Reuse the existing import; do not bump.
- **No new dependencies beyond `ulid`.** The parser uses standard string/regex operations; no Markdown AST library is needed (the BMad parser at `parse-bmad-story.ts` is the precedent and uses regex / line-walking).

## File-structure requirements

NEW files (do not exist today; verified by `ls`):

- `plugins/crew/mcp-server/src/adapters/native/index.ts`
- `plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts`
- `plugins/crew/mcp-server/src/adapters/native/native-adapter.integration.test.ts`
- `plugins/crew/mcp-server/src/adapters/native/fixtures/.crew/native-stories/01JX9000000000000000000001.md`
- `plugins/crew/mcp-server/src/adapters/native/fixtures/.crew/native-stories/01JX9000000000000000000002.md`
- `plugins/crew/mcp-server/src/schemas/native-story.ts`
- `plugins/crew/mcp-server/src/tools/write-native-story.ts`
- `plugins/crew/mcp-server/src/tools/write-native-story.integration.test.ts`
- `plugins/crew/mcp-server/src/skills/plan-skill-shape.test.ts` (or co-located as appropriate)
- `plugins/crew/skills/plan/SKILL.md`

UPDATE files (exist today; story modifies):

- `plugins/crew/mcp-server/src/adapters/registry.ts` — append `NativeAdapter` to the `adapters` array.
- `plugins/crew/mcp-server/src/tools/register.ts` — register `writeNativeStory`.
- `plugins/crew/mcp-server/src/errors.ts` — add `MalformedNativeStoryError`, `WrongAdapterError`.
- `plugins/crew/catalogue/planner.md` — extend `## Prompt` per Task 3.
- `plugins/crew/permissions/planner.yaml` — add `writeNativeStory` to `tools_allow`.
- `plugins/crew/docs/README-install.md` — add `/crew:plan` to the surface table.
- `plugins/crew/README.md` — one-liner if present.
- `plugins/crew/mcp-server/dist/` — rebuild and commit per CLAUDE.md.

The native-stories directory `<target-repo>/.crew/native-stories/` is at the target-repo level, not the plugin level. The plugin's own fixture copy lives under `mcp-server/src/adapters/native/fixtures/.crew/native-stories/` for tests.

## Testing requirements

- vitest is the test runner (see existing `*.integration.test.ts` files in the BMad adapter tree).
- The integration suite from Task 6.3 + 6.4 satisfies epic AC5.
- The deterministic structure test from Task 6.5 satisfies AC6.
- Unit tests for `parseNativeStory` are recommended (assert each `MalformedNativeStoryError` path) but not blocking AC5 — the integration suite exercises the happy path.
- AC4's user-value AC quality is hard to assert deterministically against an LLM. The recommended verification routes for the pre-PR user-surface gate are: (a) **automated** — a scripted-conversation test that asserts the resulting AC text matches a regex pattern excluding implementation vocabulary (`function`, `class`, `import`, `file`, `MCP tool`, …); OR (b) **operator-pasted verbatim Claude Code output** of a planning run where the operator confirms the ACs read at user-value level. Either route satisfies the pre-PR gate per `user-surface-acs.md` § How the gate uses this.

## Previous-story intelligence

- **Story 3.1** landed `PlanningAdapter` interface + registry + `getActiveAdapter()`. This story consumes both unchanged.
- **Story 3.2** landed execution-manifest schema + `scanSources` MCP tool. This story does not call `scanSources` directly; the `/crew:plan` skill's BMad branch *offers* the user a follow-up `/crew:scan` invocation but does not invoke it.
- **Story 3.3** landed `BmadAdapter` with `parse-bmad-story.ts`, `map-bmad-status.ts`, fixtures, and an integration test suite. **Mirror the file layout** for the native adapter exactly: `adapters/native/index.ts`, `adapters/native/parse-native-story.ts`, `adapters/native/fixtures/`, `adapters/native/native-adapter.integration.test.ts`. Consistency across adapters is load-bearing for future adapter authors.
- **Story 3.3b** moved adapter-config seam into `resolveWorkspace`. The native adapter has no per-repo config (`defaultConfig()` returns `{}`) so this story's interaction with `resolveWorkspace` is trivial — the native branch of the `adapter_config` switch is empty.
- The `planner` catalogue role + `permissions/planner.yaml` already exist (Epic 2 / hiring work). This story **extends** the prompt and **adds one tool** (`writeNativeStory`) to the allowlist; it does not introduce the role.

## Project-context reference

- **Authoritative PRD:** `_bmad-output/planning-artifacts/prd-crew-v1/` (sharded). Functional requirements cited: FR1, FR2, FR3, FR4, FR12, FR13.
- **Authoritative architecture:** `_bmad-output/planning-artifacts/architecture/planning-adapter-model.md` §Native adapter, §Story refs, §Configuration.
- **User-surface AC convention:** `plugins/crew/docs/user-surface-acs.md` (the gate-binding rubric and tag regex).
- **Build-output rule:** `plugins/crew/CLAUDE.md` (per project CLAUDE.md §Process notes) — `dist/` must be rebuilt and committed in the same change.
- **Communication style:** speak to Jack in PM language per `/Users/jackmcintyre/projects/crew/CLAUDE.md` §How to talk to Jack. Recommend defaults; do not pause for engineering judgement.

---

## Story completion status

Status: ready-for-dev

Ultimate context engine analysis completed — comprehensive developer guide created.

Notes for the dev agent:
- Six ACs total (AC1–AC5 from the epic + AC6 added per spec brief for deterministic skill-file content-structure).
- ACs tagged `user-surface`: AC1, AC2, AC4, AC6. AC3 untagged (internal schema). AC5 tagged `(integration)` per epic verbatim.
- The Behavioural contract section is required by the spec brief and IS present — see § Behavioural contract above. Cite it from the catalogue prompt per Task 3.2.
- Do not run `/plan` from inside the dev workflow; this story authors the skill, it does not exercise it in production. The integration test from Task 6.4 is the in-CI exercise route; operator-pasted verbatim Claude Code output is the manual route for the AC4 pre-PR gate.
