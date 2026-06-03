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
export declare function assembleAskModePrompt(opts: AssembleAskModePromptOptions): string;
/**
 * The verbatim `<ask-mode>` block static text (before question substitution).
 * Exported so tests can assert the block is present in the assembled prompt.
 */
export declare const ASK_MODE_BLOCK_STATIC: string;
/**
 * The AC6 error block for when the requested role is not hired.
 * Exported so the skill body and tests share the same verbatim text.
 */
export declare function formatUnhiredRoleError(role: string): string;
