/**
 * `buildJudgeContext` helper — Story native:01KTKK5NQWTV4NHB37V7WC6AD8.
 *
 * Assembles the shared judge context (persona + draft spec + rubric) once and
 * returns, per lens, a prompt = sharedPrefix + per-lens instruction suffix.
 *
 * ## Why this matters
 *
 * Before this helper the gate-1 workflow built each lens prompt inside the
 * per-lens fan-out loop, repeating the persona + specText + rubric preamble
 * five times. This helper hoists that shared work out of the loop so:
 *
 *   1. The shared prefix is byte-identical across all lens prompts — a
 *      prerequisite for the Claude Code Workflow runtime to share the prompt
 *      cache across sibling agent() calls rather than re-creating it five times
 *      at premium-model rates.
 *
 *   2. Unit tests can verify (a) byte-identity of the prefix across lenses and
 *      (b) content-preservation — every assembled prompt still contains the full
 *      persona, spec, and rubric text, so the refactor cannot silently alter what
 *      a lens sees (verdict-safety guarantee).
 *
 * ## Prefix vs suffix split
 *
 * sharedPrefix = persona + task preamble + draft spec + risk tier line
 *
 * per-lens suffix = lens name line + role line + rubric check + CLI command
 *
 * The suffix is the only part that differs between lenses. The prefix is
 * byte-identical regardless of which lens (or how many lenses) are in the plan.
 *
 * ## Single shared persona
 *
 * Using a single shared persona (passed in as `judgePersona`) rather than a
 * per-lens role persona is what makes the prefix byte-identical. The lens's
 * specific role is identified in the suffix. This matches the existing gate-1
 * fallback: the per-lens role persona is opportunistic (better role fit) while
 * the generalist-reviewer persona serves as the universal judge base.
 *
 * Story native:01KTKK5NQWTV4NHB37V7WC6AD8.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for buildJudgeContext. */
export interface BuildJudgeContextOptions {
  /**
   * The shared judge persona text — used as-is as the prefix base.
   * Should be the same string for every lens so the prefix is byte-identical.
   * In gate-1 this is the generalist-reviewer persona from buildPersonaSpawnPrompt.
   */
  judgePersona: string;

  /**
   * The draft spec text to include in every lens prompt.
   * Must be non-empty (gate-1 already guards against an empty spec).
   */
  specText: string;

  /**
   * The risk tier of the draft (e.g. 'low', 'medium', 'high').
   * Included in the shared prefix so all lenses grade against the same tier.
   * Falls back to 'medium (fallback)' when absent.
   */
  riskTier?: string;

  /**
   * The lens names to build prompts for (e.g. from judgePlan.lenses).
   * One prompt is returned per entry.
   */
  lenses: string[];

  /**
   * Per-lens rubric instruction text (the abbreviated check from LENS_RUBRIC).
   * Keyed by lens name. Missing lenses get an empty string.
   */
  lensRubric: Record<string, string>;

  /**
   * Per-lens role name (the role assigned to each lens by resolveLensRoles).
   * Keyed by lens name. Missing lenses fall back to 'generalist-reviewer'.
   */
  lensRoles: Record<string, string>;

  /**
   * The story ref (e.g. 'native:01KT…'). Used in the CLI command template.
   */
  ref: string;

  /**
   * The session ULID. Used in the CLI command template.
   */
  sessionUlid: string;

  /**
   * Absolute path to the mcp-server dist/cli.js. Used in the CLI command template.
   */
  cli: string;

  /**
   * The absolute path to the target repo root. Used in the CLI command template.
   * Also used to derive the verdict file path shown to each lens judge.
   */
  targetRepoRoot: string;
}

/** Result of buildJudgeContext. */
export interface BuildJudgeContextResult {
  /**
   * The shared prefix — byte-identical across every lens prompt.
   * = judgePersona + "\n\n" + task preamble + spec + risk tier line.
   * Callers may use this for logging / measurement.
   */
  sharedPrefix: string;

  /**
   * Per-lens full prompts. Keyed by lens name.
   * Each value = sharedPrefix + per-lens suffix (lens/role/rubric/CLI).
   */
  perLens: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helper: sanitise a ref for use as a path segment (mirrors the TS helper).
// ':' → '-'  (e.g. 'native:01KT...' → 'native-01KT...').
// ---------------------------------------------------------------------------

function sanitiseRefForPathSegment(ref: string): string {
  return ref.replace(/:/g, "-");
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Assemble the shared judge context once and return per-lens full prompts.
 *
 * Pure function — no I/O, no LLM calls, no side effects. The caller supplies
 * all inputs; this function only does string assembly and returns the result.
 *
 * AC1: the returned `sharedPrefix` is byte-identical across all lens entries
 * in `perLens` (each value starts with `sharedPrefix`).
 *
 * AC3: each value in `perLens` contains the full `judgePersona`, `specText`,
 * and rubric preamble — no section is dropped or truncated.
 */
export function buildJudgeContext(
  opts: BuildJudgeContextOptions,
): BuildJudgeContextResult {
  const {
    judgePersona,
    specText,
    riskTier,
    lenses,
    lensRubric,
    lensRoles,
    ref,
    sessionUlid,
    cli,
    targetRepoRoot,
  } = opts;

  const riskLabel = riskTier || "medium (fallback)";
  const sanitisedRef = sanitiseRefForPathSegment(ref);

  // ---------------------------------------------------------------------------
  // Shared prefix — built ONCE, reused byte-identically for every lens.
  //
  // The prefix mirrors the content each lens received BEFORE this refactor:
  //   1. The judge persona (identical to the pre-refactor lensPersona base)
  //   2. The task-preamble heading
  //   3. The "your only job is to grade..." instruction (minus lens-specific parts)
  //   4. The draft spec
  //   5. The risk tier
  //
  // Everything that differs per lens (lens name, role, rubric check, CLI command)
  // is deferred to the per-lens suffix.
  // ---------------------------------------------------------------------------

  const sharedPrefix =
    `${judgePersona}\n\n` +
    `## Your task: grade a draft story against ONE lens\n\n` +
    `You are a lens judge for the gate-1 panel. ` +
    `Your ONLY job is to grade the draft below against your assigned lens, ` +
    `then call the CLI tool to record your verdict. ` +
    `You MUST call writeLensVerdict exactly once and then stop — do NOT edit any files, do NOT run any other commands.\n\n` +
    `**Risk tier:** ${riskLabel}\n\n` +
    `**Draft spec:**\n\`\`\`\n${specText}\n\`\`\`\n\n`;

  // ---------------------------------------------------------------------------
  // Per-lens suffix — the only part that differs between lenses.
  //
  // Contains: lens name, assigned role, lens-specific rubric check, CLI command.
  // ---------------------------------------------------------------------------

  const perLens: Record<string, string> = {};

  for (const lens of lenses) {
    const role = lensRoles[lens] || "generalist-reviewer";
    const rubricCheck = lensRubric[lens] || "";
    const verdictFilePath = `${targetRepoRoot}/.flow/state/sessions/${sessionUlid}/${sanitisedRef}/judge-${lens}.json`;

    const cliArgs = JSON.stringify({
      targetRepoRoot,
      sessionUlid,
      ref,
      lens,
      role,
      pass: "<true|false>",
      missed:
        "<non-empty string: \"nothing missed\" on pass, specific gap on fail>",
    });

    const suffix =
      `**Lens:** ${lens}\n` +
      `**Your role:** ${role}\n` +
      `**Rubric check:** ${rubricCheck}\n\n` +
      `**Required action — call this command exactly once:**\n` +
      `\`\`\`\n` +
      `node ${cli} writeLensVerdict --json '${cliArgs}'\n` +
      `\`\`\`\n\n` +
      `Replace \`"<true|false>"\` with the boolean \`true\` or \`false\` (no quotes). ` +
      `Replace \`"<non-empty string: ...>"\` with a plain string (never empty — even on a pass, write "nothing missed" or a brief summary of what you verified). ` +
      `The verdict is written to: \`${verdictFilePath}\``;

    perLens[lens] = sharedPrefix + suffix;
  }

  return { sharedPrefix, perLens };
}
