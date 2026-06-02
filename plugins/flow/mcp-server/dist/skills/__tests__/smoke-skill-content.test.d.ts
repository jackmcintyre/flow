/**
 * AC3 — /flow:smoke SKILL.md content structure check — Story 1.13.
 *
 * Reads the on-disk `plugins/flow/skills/smoke/SKILL.md`, splits its YAML
 * front-matter, and asserts the deterministic structural anchors required by AC3:
 *
 *   (i)    Frontmatter `name` equals `flow:smoke`.
 *   (ii)   Frontmatter `allowed_tools` is exactly
 *          [createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]
 *          — four tools, no extras.
 *   (iii)  All five step labels appear in the body, each paired with its expected
 *          checkpoint tool name (or null for step 5).
 *   (iv)   The body contains each of the four concrete success lines:
 *          `[smoke] step N (<name>): ok` for steps 1–4. Plus the failure-shape
 *          template `[smoke] step N (<name>): FAILED — <reason>` is present
 *          (documented shape, not a per-step line).
 *   (v)    The body contains the literal handoff line
 *          `Ready. Run /flow:start in this scratch repo.`.
 *   (vi)   The body does NOT contain a Claude-Code-style invocation of `/flow:start`
 *          beyond what appears in the handoff line — count occurrences of
 *          `/flow:start` and assert the count equals 1 (the handoff line).
 *
 * Story 1.13 Task 5.
 */
export {};
