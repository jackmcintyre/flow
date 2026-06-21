# Install flow

> **Engineer working on the plugin itself?** Launch Claude Code with
> `claude --plugin-dir <worktree>/plugins/flow` and see
> [dev-loop.md](./dev-loop.md). The six checkpoints below are the production
> install path for end-users. These two paths are kept separate so an engineer
> iterating on a worktree branch does not interfere with the stable production
> install, and vice versa.

Six checkpoints from clone to seeing the plugin recognise your repo. Each step has one runnable command and one expected confirmation. If a checkpoint fails, the failure is local to that step — don't proceed.

> Heads-up: steps 3a, 3b, 4, and 6 are **slash commands you type inside a running Claude Code session**, not shell commands. Each one prints a single-line toast back into the transcript — there's no separate TUI panel to confirm in.

> **New target repo?** Once the plugin is installed, run `/flow:init` inside any repo to scaffold it as a Flow workspace — it writes `.flow/config.yaml`, the state directories, and a starter `docs/standards.md`, then prints a how-it-works overview. The checkpoints below verify the plugin install itself.

1. **Install Claude Code.**

   ```bash
   claude --version
   ```

   Expected confirmation:

   ```text
   claude 1.2.3
   ```

   (Any line matching `^claude \d+\.\d+\.\d+`.)

2. **Clone the repo and install plugin dependencies.**

   ```bash
   git clone https://github.com/jackmcintyre/flow.git && cd flow && pnpm --dir plugins/flow install
   ```

   Expected confirmation:

   ```text
   Done
   ```

   (The final line of `pnpm install` matches `^(Done|Already up to date)`.)

3. **Load the plugin into Claude Code.**

   Run two slash commands inside a running Claude Code session, from the repo root.

   3a. Register the repo as a plugin marketplace:

   ```text
   /plugin marketplace add ./
   ```

   Expected confirmation — a single-line toast in the transcript:

   ```text
   Successfully added marketplace: flow
   ```

   If you don't see that toast, the command literal didn't register; re-check that you typed it inside Claude Code (not a shell) and that the `./` is present.

   3b. Install the `flow` plugin from that marketplace:

   ```text
   /plugin install flow@flow
   ```

   Expected confirmation — a single-line toast in the transcript:

   ```text
   ✓ Installed flow. Run /reload-plugins to apply.
   ```

   The toast tells you the next step explicitly: `/reload-plugins` (step 4 below) is what actually applies the install.

4. **Reload plugins.**

   ```text
   /reload-plugins
   ```

   Expected confirmation — a single-line toast in the transcript shaped like:

   ```text
   Reloaded: 5 plugins · 3 skills · 6 agents · 0 hooks · 3 plugin MCP servers · 1 plugin LSP server
   ```

   The exact counts vary by what else you have installed; what matters is the line starts with `Reloaded:` and the `plugin MCP servers` count is **non-zero** (that's the `flow` MCP server coming online). `/reload-plugins` reloads MCP servers in-process — **no Claude Code restart is required**.

5. **Copy the standards template into your target repo.**

   ```bash
   cp plugins/flow/docs/standards-example.md <target-repo>/docs/standards.md
   ```

   `<target-repo>` may be the same as the cloned `flow` repo (the same-repo case) or a different repo (the split-repo case) — no behavioural difference.

   Expected confirmation:

   ```text
   <target-repo>/docs/standards.md
   ```

   (`ls <target-repo>/docs/standards.md` returns the path — the file now exists.)

   Available slash commands after install:

   | Skill | Description |
   |---|---|
   | `/flow:dashboard` | One-shot cockpit — plugin/repo status, the outstanding backlog grouped by epic, and your hired team, in one read-only view. |
   | `/flow:hire` | Open a hiring conversation — the hiring manager reads your repo and proposes a starting team. Or `/flow:hire default` to hire the default five-role roster directly, no interactive proposal. |
   | `/flow:plan` | Open a planning conversation. On native repos, spawn the planner subagent to author stories; on BMad repos, point you at BMad's authoring skills. Stories are materialised into the backlog automatically — no separate scan command needed. |
   | `/flow:ask` | Open a non-mutating side-session with a hired role — ask one question, get one answer. |

6. **Run `/<plugin>:dashboard` and see the current adapter state.**

   ```text
   /flow:dashboard
   ```

   (Run inside Claude Code, with `<target-repo>` loaded as the workspace.)

   Expected confirmation **today** — the dashboard's **Status** section renders a known-limitation toast as a per-section `unavailable —` line:

   ```text
   bmad adapter: detect lands in Story 3.3
   ```

   This is the **current ground-truth output on a clean install**. The BMad adapter's detect path is parked — it ships in Story 3.3 ("BMad adapter detect path"). Until then, the dashboard's **Status** section correctly reports that no adapter has been confirmed for the repo. Seeing the line above means the plugin is installed, the MCP server is running, and the read tools are wired through end-to-end; only the adapter probe is still stubbed.

   Once Story 3.3 lands, the **Status** section will instead render the full status block (`flow vX.Y.Z`, target repo, adapter, standards, cycle). This README will be updated in the same change.

## Planning-discipline enforcement

Story 3.5 introduced automatic planning-discipline validation at two points in the backlog lifecycle:

**At authoring time (`/flow:plan` — native adapter only):** The planner subagent calls `validatePlannerBacklog` before writing any story. If a story violates a discipline rule, the planner refuses to write and surfaces the violation to the operator. The four refusal codes are:

- `missing-integration-ac` — a state-mutating story has no integration-tagged AC. Fix: add a `(integration)`-tagged AC that exercises the changed code path end-to-end.
- `implicit-depends-on` — a story references another story's ref in its narrative or ACs but omits it from `depends_on`. Fix: add the ref to `depends_on`, or rephrase to remove the cross-story reference.
- `missing-ship-gate` — no story in the backlog is flagged as the release gate. Fix: designate one story (`ship_gate: true`) or author a dedicated ship-gate story that `depends_on` every other story.
- `state-mutating-without-integration-ac` — scan-time mirror of `missing-integration-ac` (forward-compat).

**At materialise time (on exit from `/flow:plan`, or automatically via `writeNativeStory` on the native adapter):** If a source story violates a discipline rule, `scan-sources` writes its manifest to `.flow/state/blocked/<ref>.yaml` (not `to-do/`) with `status: blocked`, `blocked_by: planning-discipline`, and a `discipline_violations:` block naming the rule. The materialise output prints a `blocked:` line naming the affected refs.

**Operator remediation:** Edit the source story to satisfy the violated rule, then re-run `/flow:plan`. The next materialise pass detects the changed `source_hash` and re-evaluates the story against the discipline rules. If it now passes, the blocked manifest is deleted and a new `to-do/` manifest is written automatically — the story is promoted and ready for the dev loop to claim. If the story is still violating, the blocked manifest is rewritten with the updated hash and latest violations. If the source is unchanged since the last materialise, the blocked manifest is left untouched (no spurious mtime updates).

## Discarding a feature (FR78)

Story 3.6 introduces a first-class discard flow accessible from `/flow:plan` on its second and subsequent invocations (re-open mode). Two branches:

**Native adapter — revert/deprecate story:** When you choose `discard` against a `native:<ULID>` ref, the planner authors a new story with the title prefix `revert/deprecate: ` followed by the original story's title. This new story is materialised into the backlog automatically when written (via `writeNativeStory`). The original native story file and its execution manifest are never deleted — they remain on disk for traceability.

**External-adapter (BMad) — manifest withdrawal:** When you choose `discard` against a `bmad:<source-id>` ref (or any non-native ref), the plugin calls the `markWithdrawn` MCP tool, which flips `withdrawn: true` in the execution manifest in-place (same state directory, same filename). The plugin then surfaces a reminder: `"Manifest marked withdrawn. Close the source story in <adapter-name> manually — the plugin cannot edit the source tool's tree."` Closing the source story in BMad (or whichever external tool owns it) is your responsibility.

**Confirming a withdrawal landed:** Inspect the manifest under `.flow/state/<state>/<ref>.yaml` and check for the `withdrawn: true` field. Once set, the dev loop's claim path skips the manifest automatically — it will never be picked up for implementation unless you hand-edit the field back.

## Editing stories on disk (FR14)

You can open any execution manifest in a text editor and change it directly. This is the v1 hand-edit contract.

**Where hand-edits are allowed:** any `.yaml` file under `<target-repo>/.flow/state/to-do/` or `<target-repo>/.flow/state/blocked/`. Plugin skills MUST honour your edits on the next invocation — your bytes are the source of truth until the source story's content changes.

**Fields you may edit:**

| Field | What it controls |
|---|---|
| `title` | The story's display name. |
| `narrative` | The "as a user…" paragraph. |
| `acceptance_criteria` | The list of success conditions (each has `text` and `kind`). |
| `implementation_notes` | Free-text guidance for the developer. |
| `depends_on` | The list of refs this story must come after. |
| `withdrawn` | Set `true` to manually withdraw the story from the backlog. |

**What happens on the next materialise pass (via `/flow:plan`):** If the source story's content has not changed since the last scan, your edited values are preserved — `scan-sources` detects no change to the source hash and leaves the manifest untouched. If the source story's content has changed (its fingerprint differs), `scan-sources` rewrites only the `source_hash` and `source_path` fields; your edits to `title`, `narrative`, `acceptance_criteria`, `implementation_notes`, `depends_on`, and `withdrawn` are preserved.

**Schema-violating edits:** If your edit produces invalid YAML (for example, you remove the `title` field, which is required), the next plugin skill invocation that reads the manifest will surface a `MalformedExecutionManifestError` with the path to the offending field. Fix the YAML in your editor and re-run the skill.

**Where hand-edits are NOT allowed:** `.yaml` files under `<target-repo>/.flow/state/in-progress/` are read-only for operators in v1. Once the dev loop has claimed a story (moved it to `in-progress/`), the plugin owns those bytes. The next skill invocation (`/flow:dashboard`, `/flow:plan`, or any future tool that acts on the in-progress layer) will detect the edit and refuse to proceed with this message:

```
Refusing: <ref> in in-progress/ has been hand-edited (fields: <comma-separated field names>). v1 does not support editing stories mid-flight. Wait for the story to land in done/ or blocked/, or discard it via /flow:plan.
```

Your options when you see this refusal:

1. **Wait** for the dev loop to finish the story — it will land in `done/` or `blocked/`, at which point you can edit freely again.
2. **Discard** the story via `/flow:plan` (the discard flow from Story 3.6). This withdraws the manifest cleanly without a hand-edit.

Manifests in `<target-repo>/.flow/state/done/` may be hand-edited without any plugin refusal — `done/` is the terminal state in v1 and no future tool transitions out of it.

## Build artefacts

The compiled MCP server is **committed to git by design** (Story 1.9): `/plugin install` copies the working tree as-is and does not run a build step, so the server must already be present in the tree. But only the **two self-contained bundles** are committed — `dist/index.js` (the MCP server entrypoint in `.claude-plugin/plugin.json`) and `dist/cli.js` (the workflow `node <cli> <tool>` seam). Both inline every dependency, so they boot with no `node_modules`, and they are all a clean-machine install actually loads. The rest of the tsc `dist/` tree (loose `.js` stubs + `.d.ts` types the bundles supersede) is **gitignored** (`mcp-server/.gitignore`) so a one-line `src/` change no longer drags ~566 generated files into its PR.

Contract:

- Any change to `plugins/flow/mcp-server/src/**` must be followed by `pnpm install --frozen-lockfile && pnpm build` from `plugins/flow/mcp-server/`, and the resulting `dist/index.js` + `dist/cli.js` committed in the same change (the other emitted files are ignored).
- CI fails any PR where the committed bundles drift from a fresh `pnpm build` (see `.github/workflows/ci.yml` — the `Verify committed dist/ matches fresh build` step runs `git diff --exit-code mcp-server/dist`, which now only sees the two tracked files). The vitest suite `tests/dist-shipping.test.ts` mirrors the byte-for-byte drift check locally, and `scripts/assert-clean-install.mjs` (run by `pnpm build`) is the runtime ground-truth gate: it boots the server from ONLY the two committed bundles, so it fails if either bundle stops being self-contained.
- Track exactly those two bundles under `dist/`. Do NOT commit the rest of the tsc output, and do NOT broaden the ignore to drop the two bundles — a clean-machine install would then have no server and die with `ERR_MODULE_NOT_FOUND`.
- Do NOT introduce a `prepare` / `postinstall` build hook to "fix" this. `/plugin install` won't run it. The committed-artefact path is the v1 contract.

> See Story 7.2 (Epic 7) for the full first-run walkthrough.
