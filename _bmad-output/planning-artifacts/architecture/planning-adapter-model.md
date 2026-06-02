# Planning Adapter Model

This section supersedes the original "plugin authors story files" framing baked into the PRD. The product still satisfies every PRD requirement, but the *seam* moves: the user picks their planning tool, the plugin references the tool's source files in place, and execution state lives in a thin plugin-owned layer.

## Why this changes

The original design had the plugin owning story authorship — `/<plugin>:plan` produced files under `<target-repo>/stories/<state>/`. That assumed users would adopt the plugin's planning vocabulary. In practice, users with established planning tools (BMad first; Linear, GitHub Issues, plain Markdown folders later) should be able to keep using them and have the AI Engineering Team plugin execute against them. v1 must support **BMad as a first-class adapter**; other formats are added incrementally via the same interface as they emerge.

## Two-layer model

| Layer | Owned by | Contents | Mutability from plugin |
|---|---|---|---|
| **Source layer** | The planning tool (BMad, Linear export, GitHub Issues, …) | Story files in the tool's native shape, in the tool's native location | Read-only |
| **Execution layer** | The plugin | Per-story execution manifests, telemetry, retro proposals, personas, rule registry, standards | Read/write via MCP tools |

## Adapter contract

```typescript
interface PlanningAdapter {
  name: string;                                       // "bmad" | "native" | "linear" | …
  detect(targetRepo: string): Promise<boolean>;       // can this adapter handle this repo?
  listSourceStories(): Promise<SourceStory[]>;        // canonical inventory
  readSourceStory(ref: string): Promise<SourceStory>;
  resolveSourcePath(ref: string): string;             // absolute path; dev/reviewer read directly
  watchForChanges?(): AsyncIterable<ChangeEvent>;     // optional; default: poll on skill invoke
}

type SourceStory = {
  ref: string;                       // canonical "<adapter>:<source-id>" — load-bearing identifier
  title: string;
  narrative: string;
  acceptance_criteria: AC[];         // normalised: { text: string, kind: "integration" | "unit" }
  depends_on: string[];              // refs in any adapter's namespace
  implementation_notes?: string;
  raw_path: string;                  // canonical source path on disk
  raw_frontmatter: Record<string, unknown>;  // unparsed source frontmatter, kept for traceability
  source_hash: string;               // sha256 of source file contents at read time
};

type ChangeEvent =
  | { kind: "added"; ref: string }
  | { kind: "edited"; ref: string; new_hash: string }
  | { kind: "removed"; ref: string };
```

Adapters live in `mcp-server/src/adapters/<name>/` and self-register via `mcp-server/src/adapters/registry.ts`. The MCP server resolves the active adapter on every skill invocation via `<target-repo>/.flow/config.yaml`.

## Story refs

`<adapter>:<source-id>` — e.g. `bmad:1.2.3`, `linear:ENG-441`, `native:01JX9...`.

- The ref is the join key across telemetry, verdicts, lessons, retro proposals, persona-knowledge entries.
- Refs survive a tool switch (old refs persist in retro history; new tool gets a new namespace).
- The verdict footer marker (Pattern §7) uses the ref: `<!-- crew:verdict:<plugin-version>:<ref> -->`.
- Locked-phrase grammar accepts colons in refs without escaping: `Handoff to reviewer — story bmad:1.2.3 ready for review.`

## Execution manifest

Lives at `<target-repo>/.flow/state/<state>/<ref>.yaml`. State transitions are atomic `fs.rename` between the four `<state>/` directories. Manifest shape:

```yaml
ref: "bmad:1.2.3"
status: in-progress             # mirrors directory location; validated invariant
adapter: bmad
source_path: "_bmad-output/planning-artifacts/stories/1.2.3.md"
source_hash: "<sha256 at claim time>"
claimed_by: "<session-ulid>"
risk_tier: medium
blocked_by: null
depends_on: ["bmad:1.2.2"]
verdict:
  comment_id: 12345
  standards_version: "2026.05.19"
  plugin_version: "0.1.0"
  outcome: "READY FOR MERGE"     # one of the locked sentinels
lessons:                          # populated by reviewer/dev/retro
  - kind: pitfall                 # pitfall | pattern | tool-quirk | discipline
    text: "<…>"
    failure_class: "<…>"
    routed_to: "test-specialist"
rework_count: 1
duration_seconds: 1820
withdrawn: false                  # set true if the user discards the feature (FR78)
```

Lessons that used to live in *source story frontmatter* (FR11 of the PRD) now live in the manifest. The PRD requirement is satisfied — lessons still carry `kind`, `failure_class`, are routable to specific persona files — but the on-disk location is the execution layer, not the source story.

## Source-drift handling

The source file is outside our control. Mitigations:

- `source_hash` captured at claim time.
- Dev and reviewer subagents recompute the hash when they read the source. Mismatch → the MCP tool returns a typed `SourceDriftError`; the calling skill blocks the story (`in-progress/` → `blocked/`) with `blocked_by: source-drift`.
- The orchestration session surfaces source-drift blockers as a distinct one-line surface ("`<ref>` source edited mid-flight — review and re-claim").
- The user resolves by deciding: edit the manifest hash to accept the new spec, revert the source edit, or drop the story.

## BMad adapter — v1 reference implementation

The BMad adapter is the implementation that makes the "excellent BMad support" promise concrete. Scope for v1:

- Reads BMad-generated stories from the BMad output folder (`_bmad-output/...`) — exact path is `adapter_config.stories_root` in `config.yaml`; the adapter ships a sensible default.
- Understands BMad's frontmatter (story id, status, dependencies, AC structure) and normalises to `SourceStory`.
- Maps BMad's lifecycle vocabulary (Draft / Approved / InProgress / Done — or whatever BMad's current convention is) to our `to-do / in-progress / blocked / done` execution states. Discrepancies (e.g. BMad-status says Done while our manifest says in-progress) surface as a reconciliation prompt, not a silent override.
- Recognises BMad's epic structure as a grouping hint for orchestration (a stale claim on an in-flight epic is more interesting than one on an isolated story) — soft signal, not load-bearing.
- Defers BMad-native authoring to BMad's own skills (`bmad-create-story`, `bmad-sprint-planning`, `bmad-edit-prd`, `bmad-retrospective`). The plugin's `/<plugin>:plan` skill for BMad-repos is a thin pointer: "use BMad to author; come back here to execute."

The BMad retro (`bmad-retrospective`) coexists with our retro analyst. They look at different signals: BMad's looks at *epic* outcomes and *user-facing* lessons; ours looks at *execution* signals (verdict misses, failure_class trends, team-fitness). The retro analyst's proposal file can reference BMad retro outputs but does not duplicate them.

## Native adapter — for users without a planning tool

A built-in adapter that authors story files directly under `<target-repo>/.flow/native-stories/<ref>.md` using the body shape pinned in Pattern §2. Functionally equivalent to the original "plugin owns stories" design, now scoped to one adapter rather than the whole product.

`/<plugin>:plan` invokes the planner agent against the native adapter only. For external adapters, the skill is a pointer back to the source tool.

## Configuration

`<target-repo>/.flow/config.yaml`:

```yaml
adapter: bmad                   # "bmad" | "native" | <future adapter name>
adapter_config:
  stories_root: "_bmad-output/planning-artifacts/stories"
  # adapter-specific keys
plugin:
  agreement_threshold: 0.8
  orchestration_interval_seconds: 120
```

If no config exists on first skill invocation, the plugin runs `detect()` against the target repo in registration order; first match wins; an unambiguous match writes the config. Multiple matches → prompt the user.

## Implications for earlier sections

| Earlier decision | Resolution |
|---|---|
| §Decisions A — "Story id scheme: ULID" | ULID applies to the `native` adapter only. Refs in general are `<adapter>:<id>`. |
| §Decisions A — "Story file format: Markdown + YAML frontmatter" | Applies to the native adapter's source files and to plugin-owned manifests. External adapters define their own contract. |
| §Patterns §1 — Frontmatter conventions | Applies to plugin-owned artifacts only. Source story frontmatter belongs to the adapter. |
| §Patterns §2 — Story body shape | Applies to the native adapter only. (Edited in place above.) |
| Original `<target-repo>/stories/` tree | Replaced by `<target-repo>/.flow/state/{to-do,in-progress,blocked,done}/<ref>.yaml`. Source stories live wherever the tool puts them. |
| FR55 (story-level retro into story frontmatter) | Satisfied by writing to the execution manifest's `lessons:` block. The PRD's `lessons[]`, `failure_class`, `duration_seconds`, `rework_count` all survive verbatim — just in a different file. |
| FR78 (discard a built feature) | For external adapters, the user does this in their planning tool *and* marks `withdrawn: true` in our manifest. The plugin's `/<plugin>:plan` skill for external adapters offers a "mark as withdrawn" affordance that does the manifest write. |

## Risks introduced by this model

- **Source drift while a story is in flight.** Mitigated by `source_hash` + drift detection (above).
- **Adapter quality determines product quality.** A buggy BMad adapter that misreads dependencies is indistinguishable from a planning miss. Mitigation: each adapter ships with its own integration test suite that exercises a fixture target repo of the relevant shape; BMad's fixture is committed to `plugins/flow/adapters/bmad/fixtures/`.
- **Cross-adapter dependency edges.** `depends_on` can cross adapter namespaces (mixed-adapter repo). Allowed but not actively supported in v1; the adapter registry handles cross-namespace lookups, but no skill assumes mixed repos in its UX.
- **Adapter detection ambiguity on greenfield repos.** A near-empty repo may match no adapter (or both). Mitigation: `detect()` returns false on ambiguity; first invocation prompts the user to choose explicitly; choice persists to config.
