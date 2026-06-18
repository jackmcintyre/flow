/**
 * Pure prompt-assembly helper for the `/flow:ask` side-session skill
 * (Story 2.7 AC1, AC4(a)).
 *
 * Exported as a standalone module so the integration test can call it
 * directly without spawning a real Claude Code `Task` subagent.
 *
 * No IO, no side effects. Concatenates:
 *   1. The persona's `## Prompt` section body (verbatim).
 *   2. A blank line separator.
 *   3. The load-bearing `<ask-mode>` block with `<question>` substituted
 *      by the operator's actual question text.
 *
 * (FR76, FR109, NFR12)
 */

// Convention: operator-facing prose strings must use {placeholder} not <placeholder> — angle
// brackets are stripped by Claude Code's markdown renderer (unknown HTML tags). Code blocks
// are exempt. See: Epic 2 retro, Story 2.4 / 2.5.
/** The static `<ask-mode>` block template. `__QUESTION__` is the substitution sentinel. */
const ASK_MODE_BLOCK_TEMPLATE = `<ask-mode>
You are running in /flow:ask mode. This is a non-mutating side-session.

You MAY read:
  - PR comments and PR metadata via \`gh pr view\` and \`gh api\` read-only paths.
  - Story manifests at <target-repo>/_bmad-output/planning-artifacts/stories/*.md (or the active adapter's equivalent).
  - Persona files at <target-repo>/team/<role>/PERSONA.md.
  - The standards doc at <target-repo>/docs/standards.md (or the configured standards path).

You MUST NOT mutate canonical state. The MCP server will refuse any tool call
that writes to story manifests, registry, telemetry, or persona files. If you
need to recommend a mutation, surface it as plain text in your reply — the
operator will decide whether to run the corresponding skill (e.g. \`/flow:hire\`
to hire a missing role, the dev-loop to record a verdict, etc.).

Your reply is the operator's one-shot answer to: __QUESTION__
</ask-mode>`;

export interface AssembleAskModePromptOptions {
  /** The verbatim body of the persona's `## Prompt` section. */
  personaPromptBody: string;
  /** The operator's question, verbatim. Will be substituted into the `<ask-mode>` block. */
  question: string;
}

/**
 * Assemble the full system prompt for a `/flow:ask` side-session.
 *
 * Result is:
 *   <personaPromptBody>\n\n<ask-mode block with question substituted>
 */
export function assembleAskModePrompt(opts: AssembleAskModePromptOptions): string {
  const { personaPromptBody, question } = opts;
  const askModeBlock = ASK_MODE_BLOCK_TEMPLATE.replace("__QUESTION__", question);
  return `${personaPromptBody}\n\n${askModeBlock}`;
}

/**
 * The verbatim `<ask-mode>` block static text (before question substitution).
 * Exported so tests can assert the block is present in the assembled prompt.
 */
export const ASK_MODE_BLOCK_STATIC = ASK_MODE_BLOCK_TEMPLATE.replace(
  " __QUESTION__",
  " <question>",
);

/**
 * The AC6 error block for when the requested role is not hired.
 * Exported so the skill body and tests share the same verbatim text.
 */
export function formatUnhiredRoleError(role: string): string {
  return `flow:ask — role "${role}" is not hired in this repo.

Run /flow:hire to hire a project-shaped team (interactive), or /flow:hire default to hire the default roster (planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator).

If you meant a different role id, run /flow:dashboard to see your current roster.`;
}
