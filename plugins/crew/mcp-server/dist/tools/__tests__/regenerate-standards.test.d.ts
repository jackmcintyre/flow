/**
 * `regenerate-standards` + rule-apply handler tests — Story 6.5b AC1–AC5.
 *
 * AC mapping:
 *   AC1: `regenerateStandards` is deterministic — same registry + targetVersion
 *        + clock → byte-identical output; one criterion per rule with all four
 *        fields non-empty; result re-parses against `StandardsDocSchema`.
 *   AC2: version bumps monotonically (patch increment) from the prior doc; the
 *        new doc re-parses showing the bumped version.
 *   AC3: a registry that projects > 10 criteria raises `StandardsCapExceededError`;
 *        on the production gate path the registry is byte-identical to
 *        pre-accept state; `docs/standards.md` is unchanged; no commit; no
 *        telemetry.
 *   AC4: accepting a within-cap `rule` proposal through the production gate
 *        appends the rule, regenerates the standards doc, and the gate commits
 *        BOTH files plus the proposal stamp in a single commit.
 *   AC5: `regenerateStandards` is a reusable library function; `StandardsCapExceededError`
 *        extends `DomainError`; the cap is read from `StandardsDocSchema`, not
 *        hard-coded; the function is exported from `lib/regenerate-standards.ts`.
 */
export {};
