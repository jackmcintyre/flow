/**
 * Typed error hierarchy for the crew plugin.
 *
 * All domain errors extend `DomainError`. The MCP boundary
 * (tool handlers in later stories) maps these to MCP errors.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Preserve V8 stack frames if available.
    if (typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      (Error as unknown as { captureStackTrace: (t: object, c?: object) => void }).captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown when a method or seam exists for future stories but has
 * no behavior yet. Always include the story reference that will
 * land the real implementation.
 */
export class NotImplementedError extends DomainError {}

/**
 * `.crew/config.yaml` exists but failed schema validation
 * (malformed YAML, missing required keys, wrong types, unknown adapter
 * name, or invalid adapter_config). User must fix the file by hand —
 * the resolver does NOT fall back to `detect()`.
 */
export class InvalidWorkspaceConfigError extends DomainError {
  readonly configPath: string;
  readonly yamlPath: string;
  readonly zodMessage: string;
  readonly schemaModule: string;

  constructor(opts: {
    configPath: string;
    yamlPath: string;
    zodMessage: string;
    schemaModule: string;
  }) {
    super(
      `${opts.configPath} is invalid at '${opts.yamlPath}': ${opts.zodMessage}. ` +
        `See ${opts.schemaModule} and the canonical example in ` +
        `plugins/crew/example/.crew/config.yaml.`,
    );
    this.configPath = opts.configPath;
    this.yamlPath = opts.yamlPath;
    this.zodMessage = opts.zodMessage;
    this.schemaModule = opts.schemaModule;
  }
}

/**
 * `.crew/config.yaml` declares an `adapter:` name that does not match
 * any registered adapter. The user must either install the matching
 * adapter package or edit the `adapter:` key in the config file.
 *
 * Thrown by `getActiveAdapter()` in Branch A (configured-adapter path)
 * when the named adapter is absent from the in-process registry.
 * (Story 3.1 AC2)
 */
export class UnknownAdapterError extends DomainError {
  readonly configuredAdapterName: string;
  readonly registeredAdapterNames: string[];
  readonly configPath: string;

  constructor(opts: {
    configuredAdapterName: string;
    registeredAdapterNames: string[];
    configPath: string;
  }) {
    super(
      `'.crew/config.yaml' declares adapter '${opts.configuredAdapterName}' at ${opts.configPath}, ` +
        `but no adapter with that name is registered. ` +
        `Registered adapters: [${opts.registeredAdapterNames.join(", ")}]. ` +
        `Either install the matching adapter or edit the 'adapter:' key in ${opts.configPath}.`,
    );
    this.configuredAdapterName = opts.configuredAdapterName;
    this.registeredAdapterNames = opts.registeredAdapterNames;
    this.configPath = opts.configPath;
  }
}

/**
 * No registered adapter's `detect()` returned true for the target repo.
 * User must author `.crew/config.yaml` manually.
 */
export class NoAdapterMatchedError extends DomainError {
  readonly targetRepoRoot: string;
  readonly registeredAdapters: string[];

  constructor(opts: { targetRepoRoot: string; registeredAdapters: string[] }) {
    super(
      `No registered adapter recognises ${opts.targetRepoRoot}. ` +
        `Registered adapters: [${opts.registeredAdapters.join(", ")}]. ` +
        `Author .crew/config.yaml manually following ` +
        `plugins/crew/example/.crew/config.yaml.`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.registeredAdapters = opts.registeredAdapters;
  }
}

/**
 * Two or more registered adapters' `detect()` returned true for the
 * target repo. User must disambiguate by authoring config manually.
 */
export class AmbiguousAdapterError extends DomainError {
  readonly targetRepoRoot: string;
  readonly matchingAdapters: string[];

  constructor(opts: { targetRepoRoot: string; matchingAdapters: string[] }) {
    super(
      `Multiple adapters recognise ${opts.targetRepoRoot}: ` +
        `[${opts.matchingAdapters.join(", ")}]. ` +
        `Author .crew/config.yaml manually to pick one.`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.matchingAdapters = opts.matchingAdapters;
  }
}

/**
 * The configured adapter's detect() returned false for the target repo.
 * The config parsed cleanly — it is just no longer (or never was) a match
 * for this repo. Typical cause: user copied example config into a repo
 * that doesn't fit. Distinct from InvalidWorkspaceConfigError (schema fail)
 * and NoAdapterMatchedError (no config + no detect match).
 */
export class StaleWorkspaceConfigError extends DomainError {
  readonly targetRepoRoot: string;
  readonly configuredAdapter: string;
  readonly otherMatchingAdapters: string[];
  readonly schemaModule: string;

  constructor(opts: {
    targetRepoRoot: string;
    configuredAdapter: string;
    otherMatchingAdapters: string[];
    schemaModule: string;
  }) {
    const redirect =
      opts.otherMatchingAdapters.length > 0
        ? `Other registered adapters that recognise this repo: ` +
          `[${opts.otherMatchingAdapters.join(", ")}]. ` +
          `Update the 'adapter:' key in .crew/config.yaml.`
        : `No other registered adapter recognises this repo either. ` +
          `See ${opts.schemaModule} and the canonical example in ` +
          `plugins/crew/example/.crew/config.yaml.`;
    super(
      `Configured adapter '${opts.configuredAdapter}' returned detect()=false ` +
        `for ${opts.targetRepoRoot}. ${redirect}`,
    );
    this.targetRepoRoot = opts.targetRepoRoot;
    this.configuredAdapter = opts.configuredAdapter;
    this.otherMatchingAdapters = opts.otherMatchingAdapters;
    this.schemaModule = opts.schemaModule;
  }
}

/**
 * `docs/standards.md` was not found at the expected path under the target
 * repo. User must copy the shipped example to bootstrap. Distinct from
 * StandardsDocMalformedError (file exists but fails the schema).
 */
export class StandardsDocMissingError extends DomainError {
  readonly expectedPath: string;
  readonly copyTarget: string;

  constructor(opts: { expectedPath: string; copyTarget: string }) {
    super(
      `docs/standards.md not found at ${opts.expectedPath}. ` +
        `Copy the shipped template from ${opts.copyTarget} to ` +
        `<target-repo>/docs/standards.md and edit for your project. (FR45)`,
    );
    this.expectedPath = opts.expectedPath;
    this.copyTarget = opts.copyTarget;
  }
}

/**
 * `docs/standards.md` was found but failed the parser: either YAML syntax
 * is invalid, a required field is missing or wrongly typed, or the
 * 10-criterion hard cap (FR46) is exceeded. The `zodMessage` field carries
 * the formatted Zod error (or the explicit cap-violation message). The
 * user-facing `message` cites the offending field or the cap.
 */
export class StandardsDocMalformedError extends DomainError {
  readonly sourcePath: string;
  readonly zodMessage: string;
  readonly copyTarget: string;

  constructor(opts: { sourcePath: string; zodMessage: string; copyTarget: string }) {
    super(
      `docs/standards.md at ${opts.sourcePath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical shape in ${opts.copyTarget}. (FR46)`,
    );
    this.sourcePath = opts.sourcePath;
    this.zodMessage = opts.zodMessage;
    this.copyTarget = opts.copyTarget;
  }
}

/**
 * `docs/discipline-rules.yaml` was found but failed the parser: either YAML
 * syntax is invalid, a required rule field is missing or wrongly typed, or an
 * unknown key was present (the schema is `.strict()`). The `zodMessage` field
 * carries the offending Zod message (or the YAML parse error); `yamlPath`
 * names the offending rule path so the operator can find it.
 *
 * Mirrors `StandardsDocMalformedError`'s constructor shape. Distinct from an
 * absent registry — absence is NOT an error (it parses to an empty registry).
 *
 * (Story 6.5 — FR62)
 */
export class RuleRegistryMalformedError extends DomainError {
  readonly sourcePath: string;
  readonly yamlPath: string;
  readonly zodMessage: string;

  constructor(opts: { sourcePath: string; yamlPath: string; zodMessage: string }) {
    super(
      `docs/discipline-rules.yaml at ${opts.sourcePath} is malformed at '${opts.yamlPath}': ${opts.zodMessage}. ` +
        `See the schema in mcp-server/src/schemas/discipline-rules.ts. (FR62)`,
    );
    this.sourcePath = opts.sourcePath;
    this.yamlPath = opts.yamlPath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * An agent operating under a known role attempted to invoke an MCP tool
 * whose name is not in the role's tools_allow. Caught at the
 * CallToolRequestSchema handler before the tool's handler runs.
 */
export class PermissionDeniedError extends DomainError {
  readonly role: string;
  readonly attemptedTool: string;
  readonly allowedTools: readonly string[];
  readonly specPath: string;

  constructor(opts: {
    role: string;
    attemptedTool: string;
    allowedTools: readonly string[];
    specPath: string;
  }) {
    super(
      `Role '${opts.role}' is not allowed to invoke tool '${opts.attemptedTool}'. ` +
        `Allowed tools for this role: [${opts.allowedTools.join(", ")}]. ` +
        `Edit ${opts.specPath} to grant this capability through PR review (NFR13). ` +
        `(FR79/FR80/NFR12)`,
    );
    this.role = opts.role;
    this.attemptedTool = opts.attemptedTool;
    this.allowedTools = opts.allowedTools;
    this.specPath = opts.specPath;
  }
}

/**
 * An agent operating under a known role attempted to invoke a gh
 * subcommand not in the role's gh_allow. Caught at the gh() wrapper
 * before any subprocess is spawned.
 */
export class GhSubcommandDeniedError extends DomainError {
  readonly role: string;
  readonly attemptedSubcommand: string;
  readonly allowedSubcommands: readonly string[];
  readonly specPath: string;

  constructor(opts: {
    role: string;
    attemptedSubcommand: string;
    allowedSubcommands: readonly string[];
    specPath: string;
  }) {
    super(
      `Role '${opts.role}' is not allowed to invoke 'gh ${opts.attemptedSubcommand}'. ` +
        `Allowed gh subcommands: [${opts.allowedSubcommands.join(", ")}]. ` +
        `Edit ${opts.specPath} to grant this subcommand. (NFR17)`,
    );
    this.role = opts.role;
    this.attemptedSubcommand = opts.attemptedSubcommand;
    this.allowedSubcommands = opts.allowedSubcommands;
    this.specPath = opts.specPath;
  }
}

/**
 * A code path attempted to write to a canonical-state path under the
 * target repo without an MCP tool context. Routes through
 * writeManagedFile() are the only permitted entrypoint, and they
 * require an explicit { toolName, role } context.
 */
export class CanonicalFsWriteError extends DomainError {
  readonly attemptedPath: string;
  readonly canonicalPathGlob: string;

  constructor(opts: { attemptedPath: string; canonicalPathGlob: string }) {
    super(
      `Write to canonical-state path '${opts.attemptedPath}' ` +
        `(matches '${opts.canonicalPathGlob}') is not permitted outside an MCP tool. ` +
        `Route this write through an MCP tool that calls writeManagedFile(...). ` +
        `(FR81/NFR16)`,
    );
    this.attemptedPath = opts.attemptedPath;
    this.canonicalPathGlob = opts.canonicalPathGlob;
  }
}

/**
 * Permission spec file for the named role does not exist at the
 * expected path. Distinct from RolePermissionsMalformedError (file
 * exists but fails the schema).
 */
export class RolePermissionsMissingError extends DomainError {
  readonly role: string;
  readonly specPath: string;

  constructor(opts: { role: string; specPath: string }) {
    super(
      `Permission spec for role '${opts.role}' not found at ${opts.specPath}. ` +
        `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`,
    );
    this.role = opts.role;
    this.specPath = opts.specPath;
  }
}

/**
 * Permission spec file exists but failed the parser (YAML syntax,
 * missing required field, or unknown key).
 */
export class RolePermissionsMalformedError extends DomainError {
  readonly specPath: string;
  readonly zodMessage: string;

  constructor(opts: { specPath: string; zodMessage: string }) {
    super(
      `Permission spec at ${opts.specPath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical example in plugins/crew/permissions/generalist-dev.yaml.`,
    );
    this.specPath = opts.specPath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * A caller invoked `logTelemetryEvent` with an event whose payload
 * failed its `type`-specific Zod schema. The invalid event was NOT
 * written to the JSONL file; a `telemetry.invalid` failure event was
 * recorded in its place so the failure is never silent (NFR6 / NFR21).
 */
export class TelemetryEventInvalidError extends DomainError {
  readonly attemptedType: string;
  readonly zodPath: string;
  readonly zodMessage: string;

  constructor(opts: { attemptedType: string; zodPath: string; zodMessage: string }) {
    super(
      `Telemetry event of type '${opts.attemptedType}' failed schema validation ` +
        `at '${opts.zodPath}': ${opts.zodMessage}. ` +
        `The invalid event was NOT written; a 'telemetry.invalid' failure event ` +
        `was recorded in its place. (NFR21)`,
    );
    this.attemptedType = opts.attemptedType;
    this.zodPath = opts.zodPath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * `gitCommit` refused a call because either the commit message did
 * not match the required `<tool-name>: <ref-or-proposal-id>` shape,
 * or the `paths` set was empty. Thrown BEFORE any subprocess spawn
 * (Story 1.5 AC4).
 */
export class GitCommitMessageMalformedError extends DomainError {
  readonly invalidMessage: string;
  readonly paths: readonly string[];
  readonly reason: string;

  constructor(opts: { message: string; paths: readonly string[]; reason: string }) {
    super(
      `git commit refused: ${opts.reason}. message='${opts.message}', ` +
        `paths=[${opts.paths.join(", ")}]. ` +
        `Required shape: '<tool-name>: <ref-or-proposal-id>' (lowercase tool name, ` +
        `colon, space, non-empty body). (Story 1.5 AC4)`,
    );
    this.invalidMessage = opts.message;
    this.paths = opts.paths;
    this.reason = opts.reason;
  }
}

/**
 * BMad story file failed parser-side validation: the H1 disagrees with
 * the filename's epic/story numbers, the `Status:` line carries an
 * unknown vocabulary value, or an AC block could not be parsed. Thrown
 * by `parseBmadStory` (Story 3.3).
 */
export class MalformedBmadStoryError extends DomainError {
  readonly path: string;
  readonly reason: string;
  readonly details: Record<string, unknown>;

  constructor(opts: { path: string; reason: string; details?: Record<string, unknown> }) {
    super(
      `BMad story at '${opts.path}' is malformed: ${opts.reason}. ` +
        `See plugins/crew/docs/spikes/bmad-format.md for the expected shape. (Story 3.3)`,
    );
    this.path = opts.path;
    this.reason = opts.reason;
    this.details = opts.details ?? {};
  }
}

/**
 * `BmadAdapter.readSourceStory(ref)` or `resolveSourcePath(ref)` was
 * given a ref that does not resolve to any file under `stories_root`.
 */
export class UnknownBmadRefError extends DomainError {
  readonly ref: string;
  readonly storiesRoot: string;

  constructor(opts: { ref: string; storiesRoot: string }) {
    super(
      `BMad ref '${opts.ref}' did not resolve to any story file under ` +
        `'${opts.storiesRoot}'. (Story 3.3)`,
    );
    this.ref = opts.ref;
    this.storiesRoot = opts.storiesRoot;
  }
}

/**
 * Two or more files under `stories_root` share the same
 * `<epic>-<story>-` prefix, so a ref cannot be resolved unambiguously.
 */
export class AmbiguousBmadRefError extends DomainError {
  readonly ref: string;
  readonly matches: readonly string[];

  constructor(opts: { ref: string; matches: readonly string[] }) {
    super(
      `BMad ref '${opts.ref}' is ambiguous: multiple files match — ` +
        `[${opts.matches.join(", ")}]. Rename one file so each ` +
        `<epic>-<story>- prefix is unique. (Story 3.3)`,
    );
    this.ref = opts.ref;
    this.matches = opts.matches;
  }
}

/**
 * `moveBetweenStates` refused a move because the underlying `fs.rename`
 * returned `EXDEV` — the source and destination resolve to different
 * filesystems. v1 explicitly does NOT fall back to copy+delete because
 * that would create an observable in-between state, violating NFR8's
 * single-syscall atomicity guarantee. (Story 1.6 AC2)
 */
export class CrossFilesystemMoveError extends DomainError {
  readonly absFromPath: string;
  readonly absToPath: string;
  readonly ref: string;
  readonly originalCode: string;

  constructor(opts: {
    absFromPath: string;
    absToPath: string;
    ref: string;
    originalCode: string;
  }) {
    super(
      `Cross-filesystem move refused for manifest '${opts.ref}': ` +
        `fs.rename returned ${opts.originalCode}. ` +
        `from='${opts.absFromPath}', to='${opts.absToPath}'. ` +
        `v1 explicitly does not support cross-filesystem moves ` +
        `(NFR8 — single-syscall atomicity). Place the target repo on a ` +
        `single filesystem, or align the .crew/state/ tree ` +
        `with the repo root. (Story 1.6 AC2)`,
    );
    this.absFromPath = opts.absFromPath;
    this.absToPath = opts.absToPath;
    this.ref = opts.ref;
    this.originalCode = opts.originalCode;
  }
}

/**
 * `moveBetweenStates` was asked to move a manifest from a state
 * directory where the source file does not exist. Maps the underlying
 * `ENOENT` errno from `fs.rename` to a typed domain error. (Story 1.6 AC5)
 */
export class ManifestNotFoundError extends DomainError {
  readonly ref: string;
  readonly expectedAbsPath: string;
  readonly fromState: string;

  constructor(opts: { ref: string; expectedAbsPath: string; fromState: string }) {
    super(
      `Manifest '${opts.ref}' not found at '${opts.expectedAbsPath}' ` +
        `(expected in state '${opts.fromState}'). A move was requested but ` +
        `the source file does not exist. This typically means the manifest ` +
        `was already transitioned by another session, or the ref was never ` +
        `claimed. (Story 1.6 AC5)`,
    );
    this.ref = opts.ref;
    this.expectedAbsPath = opts.expectedAbsPath;
    this.fromState = opts.fromState;
  }
}

/**
 * `moveBetweenStates` refused a transition because either the `from`
 * or `to` state name is not in the canonical whitelist, OR because
 * the resolved absolute path escapes the canonical state-root tree.
 * Thrown BEFORE any filesystem operation. (Story 1.6 AC4)
 */
export class InvalidStateNameError extends DomainError {
  readonly attemptedFrom: string;
  readonly attemptedTo: string;
  readonly allowedStates: readonly string[];
  readonly reason: string;

  constructor(opts: {
    attemptedFrom: string;
    attemptedTo: string;
    allowedStates: readonly string[];
    reason: string;
  }) {
    super(
      `Invalid state-machine transition refused: ${opts.reason}. ` +
        `from='${opts.attemptedFrom}', to='${opts.attemptedTo}'. ` +
        `Allowed states: [${opts.allowedStates.join(", ")}]. (Story 1.6 AC4)`,
    );
    this.attemptedFrom = opts.attemptedFrom;
    this.attemptedTo = opts.attemptedTo;
    this.allowedStates = opts.allowedStates;
    this.reason = opts.reason;
  }
}

/**
 * Catalogue role file (`plugins/<plugin>/catalogue/<role>.md`) exists
 * but failed the parser — YAML frontmatter syntax error, missing /
 * unknown frontmatter key, or a required `##` section that is missing
 * or out of canonical order (Story 2.1).
 */
export class CatalogueShapeError extends DomainError {
  readonly code = "CATALOGUE_SHAPE_ERROR" as const;
  readonly sourcePath: string;
  readonly zodMessage: string;

  constructor(opts: { sourcePath: string; zodMessage: string }) {
    super(
      `Catalogue role at ${opts.sourcePath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical example in plugins/crew/catalogue/generalist-dev.md ` +
        `and the file shape in architecture ` +
        `implementation-patterns-consistency-rules §3.`,
    );
    this.sourcePath = opts.sourcePath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * An execution manifest at `<target-repo>/.crew/state/<state>/<ref>.yaml`
 * failed schema validation: malformed YAML, missing required field, wrong
 * type, or an unknown key (strict-mode rejection). Named so downstream
 * tooling (Story 3.5, Story 4.x) can pattern-match the error class name
 * without parsing the message string.
 *
 * Thrown by `parseExecutionManifest` in
 * `schemas/execution-manifest.ts` — every reader MUST go through that
 * helper so this error surfaces consistently. (Story 3.2 / FR13)
 */
export class MalformedExecutionManifestError extends DomainError {
  readonly absPath: string;
  readonly yamlPath: string;
  readonly zodMessage: string;
  readonly schemaModule: string;

  constructor(opts: {
    absPath: string;
    yamlPath: string;
    zodMessage: string;
    schemaModule: string;
  }) {
    super(
      `Execution manifest at ${opts.absPath} is malformed at '${opts.yamlPath}': ${opts.zodMessage}. ` +
        `See ${opts.schemaModule} for the canonical schema.`,
    );
    this.absPath = opts.absPath;
    this.yamlPath = opts.yamlPath;
    this.zodMessage = opts.zodMessage;
    this.schemaModule = opts.schemaModule;
  }
}

/**
 * `readCatalogue` / `instantiatePersona` was asked for a role that
 * does not exist in `plugins/crew/catalogue/`. Distinct from
 * `CatalogueShapeError` (file exists but malformed) — this error
 * means no file was found at the expected path. (Story 2.3)
 */
export class CatalogueRoleNotFoundError extends DomainError {
  readonly code = "CATALOGUE_ROLE_NOT_FOUND" as const;
  readonly role: string;
  readonly cataloguePath: string;

  constructor(opts: { role: string; cataloguePath: string }) {
    super(
      `Unknown catalogue role '${opts.role}': no file at ${opts.cataloguePath}. ` +
        `See plugins/crew/catalogue/ for the v1 roster.`,
    );
    this.role = opts.role;
    this.cataloguePath = opts.cataloguePath;
  }
}

/**
 * `instantiatePersona` was asked to materialise a persona file for a
 * role that has already been hired (the persona file already exists
 * on disk). v1's `/hire` skill checks this and surfaces the re-entry
 * actions (FR90); the underlying tool stays a pure create-or-fail.
 * (Story 2.3)
 */
export class PersonaAlreadyExistsError extends DomainError {
  readonly code = "PERSONA_ALREADY_EXISTS" as const;
  readonly role: string;
  readonly personaPath: string;

  constructor(opts: { role: string; personaPath: string }) {
    super(
      `Role '${opts.role}' is already hired at ${opts.personaPath}. ` +
        `Use /hire to view, unhire, or hire-one-more — re-instantiating is not idempotent.`,
    );
    this.role = opts.role;
    this.personaPath = opts.personaPath;
  }
}

/**
 * A native-story file at `<target-repo>/.crew/native-stories/<ULID>.md`
 * failed parser-side validation: missing H1, missing required section,
 * zero parseable ACs, an AC block with no Given/When/Then, or a
 * `## Dependencies` bullet that does not parse as a ref.
 *
 * Thrown by `parseNativeStory` (Story 3.4). The error message names the
 * offending file path and section.
 */
export class MalformedNativeStoryError extends DomainError {
  readonly path: string;
  readonly section: string;
  readonly reason: string;

  constructor(opts: { path: string; section: string; reason: string }) {
    super(
      `Native story at '${opts.path}' is malformed in section '${opts.section}': ${opts.reason}. ` +
        `See _bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md ` +
        `§ Task 2 for the required body shape. (Story 3.4)`,
    );
    this.path = opts.path;
    this.section = opts.section;
    this.reason = opts.reason;
  }
}

/**
 * An MCP tool was invoked against a workspace whose active adapter does not
 * match the tool's requirement. Widened in Story 3.6 to carry `toolName` so
 * the error message names the actual calling tool rather than always saying
 * `writeNativeStory`. Both call-sites (writeNativeStory, markWithdrawn)
 * pass their own `toolName`.
 *
 * Story 3.4: initial guard for `writeNativeStory`.
 * Story 3.6: widened with `toolName`; `markWithdrawn` added as second call-site.
 */
export class WrongAdapterError extends DomainError {
  readonly expectedAdapter: string;
  readonly actualAdapter: string;
  readonly targetRepoRoot: string;
  readonly toolName: string;

  constructor(opts: {
    expectedAdapter: string;
    actualAdapter: string;
    targetRepoRoot: string;
    /** Name of the MCP tool that raised this error. Defaults to "writeNativeStory" for backward compatibility. */
    toolName?: string;
  }) {
    const toolName = opts.toolName ?? "writeNativeStory";
    const remediation =
      toolName === "markWithdrawn"
        ? `Use writeNativeStory to author a revert/deprecate story for native discards.`
        : `For BMad workspaces, use /bmad-create-story instead. (Story 3.4)`;
    super(
      `${toolName} requires adapter '${opts.expectedAdapter}' but ` +
        `the resolved adapter for '${opts.targetRepoRoot}' is '${opts.actualAdapter}'. ` +
        remediation,
    );
    this.expectedAdapter = opts.expectedAdapter;
    this.actualAdapter = opts.actualAdapter;
    this.targetRepoRoot = opts.targetRepoRoot;
    this.toolName = toolName;
  }
}

/**
 * An execution manifest at `<target-repo>/.crew/state/in-progress/<ref>.yaml`
 * was found to have been hand-edited after it was claimed by the dev loop.
 * Thrown by `detectInProgressHandEdit` when the on-disk manifest's
 * operator-editable fields or `source_hash` differ from the canonical values
 * at scan-time.
 *
 * This is a hard refusal: the caller MUST surface this to the operator and
 * MUST NOT proceed with any operation on the manifest. The operator's options
 * are: wait for the story to land in `done/` or `blocked/`, or use
 * `/crew:plan` to discard the story (Story 3.6 flow).
 *
 * See Story 3.7, FR14 (second half — "orchestration surfaces the violation in v1").
 */
export class InProgressHandEditError extends DomainError {
  readonly ref: string;
  readonly changedFields: readonly string[];
  readonly absPath: string;

  constructor(opts: { ref: string; changedFields: readonly string[]; absPath: string }) {
    const fieldList = [...opts.changedFields].sort().join(", ");
    super(
      `Refusing: ${opts.ref} in in-progress/ has been hand-edited (fields: ${fieldList}). ` +
        `v1 does not support editing stories mid-flight. ` +
        `Wait for the story to land in done/ or blocked/, or discard it via /crew:plan.`,
    );
    this.ref = opts.ref;
    this.changedFields = opts.changedFields;
    this.absPath = opts.absPath;
  }
}

/**
 * `claimStory` refused because one or more `depends_on` refs are not yet in
 * `done/`. The calling session must wait for the listed dependencies to
 * complete before the ref can be claimed.
 *
 * FR18 — dependency check at claim time (Story 4.1).
 * Message format mirrors `GitCommitMessageMalformedError`'s `<tool-name> refused: <reason>`.
 */
export class DependenciesNotReadyError extends DomainError {
  readonly ref: string;
  readonly missingDeps: readonly string[];

  constructor(opts: { ref: string; missingDeps: readonly string[] }) {
    super(
      `claim-story refused: '${opts.ref}' depends on refs not yet in done/: [${opts.missingDeps.join(", ")}]. ` +
        `Wait for these stories to complete, or remove them from depends_on via the source story.`,
    );
    this.ref = opts.ref;
    this.missingDeps = opts.missingDeps;
  }
}

/**
 * `completeStory` refused because the calling session's ULID does not match
 * the `claimed_by` field on the `in-progress/` manifest. Only the session
 * that claimed the story may complete it.
 *
 * Story 4.1 AC4.
 */
export class WrongClaimantError extends DomainError {
  readonly ref: string;
  readonly expectedSessionUlid: string;
  readonly actualSessionUlid: string;

  constructor(opts: {
    ref: string;
    expectedSessionUlid: string;
    actualSessionUlid: string;
  }) {
    super(
      `complete-story refused: '${opts.ref}' was claimed by session '${opts.actualSessionUlid}' ` +
        `but the caller's session is '${opts.expectedSessionUlid}'. ` +
        `Only the claiming session may complete a story.`,
    );
    this.ref = opts.ref;
    this.expectedSessionUlid = opts.expectedSessionUlid;
    this.actualSessionUlid = opts.actualSessionUlid;
  }
}

/**
 * `readPersona` was asked for a role whose persona file does not
 * exist under `<target-repo>/team/<role>/PERSONA.md`. (Story 2.3)
 */
export class PersonaFileNotFoundError extends DomainError {
  readonly code = "PERSONA_FILE_NOT_FOUND" as const;
  readonly role: string;
  readonly personaPath: string;

  constructor(opts: { role: string; personaPath: string }) {
    super(
      `No persona file for role '${opts.role}' at ${opts.personaPath}. ` +
        `Run /hire to create one.`,
    );
    this.role = opts.role;
    this.personaPath = opts.personaPath;
  }
}

/**
 * Thrown when the dev subagent's final-output transcript does not contain
 * the verbatim locked handoff phrase `Handoff to reviewer — story <story-id>
 * ready for review.` on its last non-empty line. The in-progress manifest
 * is stamped with `blocked_by: "handoff-grammar"` in-place (Story 5.1 will
 * retrofit the atomic move to `blocked/`).
 *
 * Reserved for callers that prefer exception-style flow control over the
 * tagged-union result from `parseHandoff`. The inner cycle uses the tagged
 * union; this class is declared here for SKILL.md failure-modes documentation
 * and for future callers.
 *
 * Added in Story 4.3.
 *
 * @public — intentionally retained. Unused in code today, but the
 * `/crew:start` SKILL.md documents it as a failure mode and a test asserts
 * that doc names it, so it is part of the documented contract, not dead code.
 * The `@public` tag keeps it out of the knip bloat-gate.
 */
export class HandoffGrammarDriftError extends DomainError {
  readonly ref: string;

  constructor(opts: { ref: string }) {
    super(
      `Dev subagent for story ${opts.ref} terminated without the verbatim locked handoff phrase. ` +
        `The in-progress manifest has been stamped with blocked_by: "handoff-grammar". ` +
        `Edit the manifest to clear blocked_by and re-run /crew:start.`,
    );
    this.ref = opts.ref;
  }
}

/**
 * `parsePersonaFile` found a file on disk but it failed the parser —
 * YAML frontmatter syntax error, missing / unknown frontmatter key,
 * a required `##` section missing / out of canonical order, or the
 * required `## Knowledge` section absent / preceding `## Prompt`.
 * (Story 2.3)
 */
export class PersonaFileMalformedError extends DomainError {
  readonly code = "PERSONA_FILE_MALFORMED" as const;
  readonly personaPath: string;
  readonly zodMessage: string;

  constructor(opts: { personaPath: string; zodMessage: string }) {
    super(
      `Persona file at ${opts.personaPath} is malformed: ${opts.zodMessage}. ` +
        `Persona files are plain Markdown — fix by hand or git-revert.`,
    );
    this.personaPath = opts.personaPath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * An execa wrapper (`gh` or `git`) refused a call because the `args`
 * array contained a flag that the dev role's permission spec forbids
 * unconditionally (NFR16 / Pattern §9). Thrown BEFORE any subprocess
 * spawn; an `execaImpl` spy confirms zero calls.
 *
 * Covered by Story 4.4 AC2 (negative-capability refusal).
 */
export class NegativeCapabilityDeniedError extends DomainError {
  readonly attempted_flag: string;
  readonly role: string;
  readonly callSite: "gh" | "git";

  constructor(opts: {
    attempted_flag: string;
    role: string;
    callSite: "gh" | "git";
  }) {
    super(
      `Role '${opts.role}' attempted a forbidden flag '${opts.attempted_flag}' ` +
        `at the '${opts.callSite}' wrapper. This flag is refused unconditionally ` +
        `before any subprocess spawn (NFR16 / Pattern §9 / Story 4.4 AC2).`,
    );
    this.attempted_flag = opts.attempted_flag;
    this.role = opts.role;
    this.callSite = opts.callSite;
  }
}

/**
 * `gitCreateBranch` refused to create a branch because the supplied
 * branch name did not match the `^story/[a-z0-9-]+$` pattern.
 * Thrown BEFORE any subprocess spawn. (Story 4.4 Task 2.1)
 */
export class GitBranchNameMalformedError extends DomainError {
  readonly branchName: string;

  constructor(opts: { branchName: string }) {
    super(
      `git checkout -b refused: branch name '${opts.branchName}' does not match ` +
        `'^story/[a-z0-9-]+$'. Use buildBranchSlug() to produce a conforming name. ` +
        `(Story 4.4 Task 2.1)`,
    );
    this.branchName = opts.branchName;
  }
}

/**
 * `gitPush` returned a non-zero exit code. The local branch and commit
 * are left in place for operator-side recovery. Story 4.5 will classify
 * this as a recoverable error. (Story 4.4 AC1e)
 */
export class GitPushFailedError extends DomainError {
  readonly branchName: string;
  readonly stderr: string;

  constructor(opts: { branchName: string; stderr: string }) {
    super(
      `git push -u origin ${opts.branchName} failed. ` +
        `stderr: ${opts.stderr || "(empty)"}. ` +
        `The local branch is left in place for operator recovery. ` +
        `(Story 4.4 AC1e)`,
    );
    this.branchName = opts.branchName;
    this.stderr = opts.stderr;
  }
}

/**
 * The pre-PR build gate (`runDevTerminalAction`) ran the project's full build
 * — the same whole-project type-check command CI runs — and it exited non-zero.
 * Thrown AFTER the commit but BEFORE `gh pr create`, so NO pull request is
 * opened on a red build. Carries the build's `exitCode` and captured
 * `stdout`/`stderr` so the caller (the drain seam-agent) can surface exactly
 * what failed, instead of relying on the dev agent to have remembered to run
 * the build.
 *
 * This is the deterministic-seam fix for the #211 failure class (first real
 * end-to-end drain, 2026-05-30): a story broke an untouched sibling file, the
 * story-scoped vitest passed in isolation, and a red PR was opened because the
 * "run the build green first" mandate lived only in agent prose. The gate now
 * lives in the tool layer where the agent cannot skip it.
 *
 * Mirrors `GitPushFailedError`'s shape (typed, carries the subprocess result).
 *
 * (Story 8.17)
 */
export class PrePrBuildFailedError extends DomainError {
  readonly exitCode: number;
  readonly buildCommand: string;
  readonly buildCwd: string;
  readonly stdout: string;
  readonly stderr: string;

  constructor(opts: {
    exitCode: number;
    buildCommand: string;
    buildCwd: string;
    stdout: string;
    stderr: string;
  }) {
    super(
      `pre-PR build gate failed: '${opts.buildCommand}' (cwd: ${opts.buildCwd}) ` +
        `exited with code ${opts.exitCode}. No pull request was opened. ` +
        `Fix the build and re-run — the gate runs the project's full build ` +
        `(the same whole-project type-check CI runs), so it catches breakage in ` +
        `files the story did not touch. ` +
        `stderr: ${opts.stderr || "(empty)"}. ` +
        `stdout: ${opts.stdout || "(empty)"}. (Story 8.17)`,
    );
    this.exitCode = opts.exitCode;
    this.buildCommand = opts.buildCommand;
    this.buildCwd = opts.buildCwd;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
  }
}

/**
 * `gh pr create` returned a non-zero exit code, or the stdout did not
 * contain a valid PR URL (starts with `https://github.com/`). Story
 * 4.5 will wrap this in the recoverable-error classifier. (Story 4.4
 * AC1g, AC1i)
 */
export class GhPrCreateFailedError extends DomainError {
  readonly stderr: string;
  readonly diagnostic: string;

  constructor(opts: { stderr: string; diagnostic: string }) {
    super(
      `gh pr create failed: ${opts.diagnostic}. ` +
        `stderr: ${opts.stderr || "(empty)"}. ` +
        `Story 4.5 will classify this as recoverable or terminal. ` +
        `(Story 4.4 AC1i)`,
    );
    this.stderr = opts.stderr;
    this.diagnostic = opts.diagnostic;
  }
}

/**
 * `plugins/crew/permissions/gh-error-map.yaml` failed schema validation: the
 * top-level shape was wrong, a per-entry key was unknown, `class` was not in
 * the literal set, `exit_code` was missing or non-integer, or a `stderr_regex`
 * string could not be compiled as a JavaScript regex.
 *
 * Thrown by `parseGhErrorMap` in `lib/gh-error-map.ts`.
 *
 * `rowIndex` is 1-indexed (the first entry is row 1). Present only when the
 * error is tied to a specific entry. `offendingKey` names the YAML key that
 * caused the failure. `reason` carries the human-readable cause string.
 *
 * Story 4.5 Task 1.3
 */
export class MalformedGhErrorMapError extends DomainError {
  readonly filePath: string;
  readonly reason: string;
  readonly rowIndex?: number;
  readonly offendingKey?: string;

  constructor(opts: {
    filePath: string;
    reason: string;
    rowIndex?: number;
    offendingKey?: string;
  }) {
    const location =
      opts.rowIndex !== undefined ? ` (row ${opts.rowIndex})` : "";
    const key = opts.offendingKey ? `, offending key: '${opts.offendingKey}'` : "";
    super(
      `gh-error-map.yaml at '${opts.filePath}' is malformed${location}: ${opts.reason}${key}. ` +
        `See _bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md ` +
        `§ Behavioural contract for the required shape. (Story 4.5)`,
    );
    this.filePath = opts.filePath;
    this.reason = opts.reason;
    this.rowIndex = opts.rowIndex;
    this.offendingKey = opts.offendingKey;
  }
}

/**
 * `gh()` wrapper detected a mapped recoverable error via the `gh-error-map.yaml`
 * classifier. Raised AFTER `execaImpl` returns with a non-zero exit code and the
 * classifier returns a non-null class. The error propagates through
 * `runDevTerminalAction` unchanged; the dev subagent emits the locked marker line
 * so `processDevTranscript` can stamp `blocked_by: gh-<class>` on the in-progress
 * manifest.
 *
 * Fields:
 * - `class` — one of `"defer" | "retry" | "needs-human"` (the mapped class from the YAML table).
 * - `exitCode` — the `gh` process exit code.
 * - `stderr` — the raw stderr string from `gh`.
 * - `subcommand` — the kebab-cased subcommand (e.g. `"pr-create"`).
 *
 * Story 4.5 Task 3.1
 */
export class GhRecoverableError extends DomainError {
  readonly class: "defer" | "retry" | "needs-human";
  readonly exitCode: number;
  readonly stderr: string;
  readonly subcommand: string;

  constructor(opts: {
    class: "defer" | "retry" | "needs-human";
    exitCode: number;
    stderr: string;
    subcommand: string;
  }) {
    super(
      `gh ${opts.subcommand} failed and was classified as recoverable:${opts.class}. ` +
        `exit=${opts.exitCode}. stderr: ${opts.stderr || "(empty)"}`,
    );
    this.class = opts.class;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.subcommand = opts.subcommand;
  }
}

/**
 * `runDevTerminalAction` received a `type` argument that is not in the
 * conventional-commits type set. Thrown BEFORE any subprocess spawn.
 * (Story 4.4 AC1b)
 */
export class ConventionalCommitTypeUnknownError extends DomainError {
  readonly attempted_type: string;
  readonly allowed_types: readonly string[];

  constructor(opts: { attempted_type: string; allowed_types: readonly string[] }) {
    super(
      `Conventional-commits type '${opts.attempted_type}' is not recognised. ` +
        `Allowed types: [${opts.allowed_types.join(", ")}]. ` +
        `(Story 4.4 AC1b)`,
    );
    this.attempted_type = opts.attempted_type;
    this.allowed_types = opts.allowed_types;
  }
}

/**
 * Two or more standards criteria slugify to the same id.
 *
 * `runReviewerSession` raises this when building `standardsByCriterionId`
 * and detects that `slugifyStandardsCriterion(name)` produces the same key
 * for two distinct criteria. This is an authoring bug in `docs/standards.md`
 * — the operator must rename one criterion to make ids unique.
 *
 * (Story 4.6 Task 3.3 / AC3c)
 */
export class DuplicateStandardsCriterionIdError extends DomainError {
  readonly criterionId: string;
  readonly names: string[];

  constructor(opts: { criterionId: string; names: string[] }) {
    super(
      `Two or more standards criteria slugify to the same id '${opts.criterionId}': ` +
        `${opts.names.join(", ")}. ` +
        `Rename one in docs/standards.md to make ids unique.`,
    );
    this.criterionId = opts.criterionId;
    this.names = opts.names;
  }
}

/**
 * `processDevTranscript` could not parse a GitHub PR URL from the dev
 * subagent's transcript on the happy-path `spawn-reviewer` branch.
 *
 * Raised when `parseHandoff` succeeds (the dev claimed completion) but no
 * line in the transcript matches `https://github.com/.../pull/<n>`. This
 * typically means the dev pushed but `gh pr create` did not surface the PR
 * URL in the transcript, or the PR was not created at all.
 *
 * The `transcriptTail` field carries the last ~500 characters of the
 * transcript for operator diagnostics.
 *
 * (Story 4.6 Task 3.4 / AC1g)
 */
export class PrUrlNotFoundInDevTranscriptError extends DomainError {
  readonly ref: string;
  readonly transcriptTail: string;

  constructor(opts: { ref: string; transcriptTail: string }) {
    super(
      `Could not parse a GitHub PR URL from the dev subagent's transcript for story ${opts.ref}. ` +
        `Expected a line containing 'https://github.com/.../pull/<n>'. ` +
        `Last 500 chars of transcript: ${opts.transcriptTail}`,
    );
    this.ref = opts.ref;
    this.transcriptTail = opts.transcriptTail;
  }
}

/**
 * `processReviewerTranscript` found `reviewer-result.json` at the expected
 * path but could not parse or validate it. This is a bug in `runReviewerSession`
 * — the file should always be schema-valid when present.
 *
 * Fields:
 * - `path` — the absolute path to the malformed file.
 * - `cause` — the raw parse/validation error.
 *
 * (Story 4.6 Task 8b.8 / revision 2)
 */
export class ReviewerResultFileMalformedError extends DomainError {
  readonly path: string;
  readonly cause: unknown;

  constructor(opts: { path: string; cause: unknown }) {
    super(
      `reviewer-result.json at ${opts.path} is malformed or fails schema validation. ` +
        `Cause: ${String(opts.cause)}. ` +
        `This is a bug in runReviewerSession; the file should always be schema-valid when present.`,
    );
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/**
 * A `gh api` subcommand returned a response body that could not be parsed
 * as JSON or did not match the expected shape. Raised by
 * `postReviewerComments` when `gh api .../reviews` returns non-JSON stdout
 * or when `gh repo view --json owner,name` returns an unexpected shape.
 *
 * Fields:
 * - `subcommand` — the kebab-cased subcommand (e.g. `"api"`, `"pr-view"`).
 * - `url` — the API URL path (only present for `api` calls).
 * - `cause` — the raw parse/validation error.
 *
 * Story 4.6b Task 6.1
 */
export class GhApiResponseShapeError extends DomainError {
  readonly subcommand: string;
  readonly url?: string;
  readonly cause: unknown;

  constructor(opts: { subcommand: string; url?: string; cause: unknown }) {
    super(
      `gh ${opts.subcommand} returned an unexpected response shape${opts.url ? " at " + opts.url : ""}. ` +
        `Cause: ${opts.cause}. This is either a gh CLI change or a stub mismatch in tests.`,
    );
    this.subcommand = opts.subcommand;
    this.url = opts.url;
    this.cause = opts.cause;
  }
}

/**
 * `composeVerdictLine` reached the BLOCKED branch but `acResults` is neither
 * empty nor contains a `manual-check-required` entry. Per Story 4.6 §3f this
 * state is unreachable in a non-mutated `reviewer-result.json` — reaching it
 * means the persisted file was mutated out-of-band (e.g. hand-edited). Raised
 * to refuse fabricating a reason string that would violate AC2's enumerated
 * grammar.
 *
 * Story 4.6b Task 6.2
 */
export class UnreachableBlockedReasonError extends DomainError {
  readonly acResultKeys: readonly string[];

  constructor(opts: { acResults: Record<number, unknown> }) {
    super(
      `composeVerdictLine reached the BLOCKED branch but acResults is neither empty ` +
        `nor contains a manual-check-required entry. Per Story 4.6 §3f this is unreachable ` +
        `in a non-mutated reviewer-result.json. acResults keys: ${Object.keys(opts.acResults).join(", ")}.`,
    );
    this.acResultKeys = Object.keys(opts.acResults);
  }
}

/**
 * `buildBranchSlug` produced a slug that had no alphanumeric characters
 * after the `story/` prefix (e.g. a title composed entirely of Unicode
 * / punctuation). Thrown BEFORE any subprocess spawn. (Story 4.4
 * Implementation strategy — Risks)
 */
export class BranchSlugUnrenderableError extends DomainError {
  readonly ref: string;
  readonly title: string;

  constructor(opts: { ref: string; title: string }) {
    super(
      `Cannot compose a renderable branch slug from ref='${opts.ref}', ` +
        `title='${opts.title}'. After applying slug rules, the title-slug ` +
        `portion contained no alphanumeric characters. Use an ASCII-safe ` +
        `title. (Story 4.4)`,
    );
    this.ref = opts.ref;
    this.title = opts.title;
  }
}

/**
 * `processDevTranscript` found `dev-outcome.json` at the expected path but
 * could not parse or validate it. This is a bug in `runDevTerminalAction`
 * — the file should always be schema-valid when present.
 *
 * A malformed file is NOT silently fallen back to transcript scanning;
 * it is a write-seam bug and must surface as a hard error.
 *
 * Fields:
 * - `path` — the absolute path to the malformed file (encodes the session
 *             via `.../sessions/<sessionUlid>/dev-outcome.json`).
 * - `cause` — the raw parse/validation error or a descriptive string naming
 *             the offending field.
 *
 * (Story 4.8b Task 2 / AC4)
 */
export class DevOutcomeFileMalformedError extends DomainError {
  readonly path: string;
  readonly cause: unknown;

  constructor(opts: { path: string; cause: unknown }) {
    super(
      `dev-outcome.json at ${opts.path} is malformed or fails schema validation. ` +
        `Cause: ${String(opts.cause)}. ` +
        `This is a bug in runDevTerminalAction; the file should always be schema-valid when present.`,
    );
    this.path = opts.path;
    this.cause = opts.cause;
  }
}

/**
 * `docs/risk-tiering.md` was found (at either the target-repo override path or
 * the shipped-default path) but failed the parser: either YAML frontmatter is
 * missing or ill-formed, YAML syntax is invalid, a required field is missing or
 * wrongly typed, or a post-Zod invariant was violated (duplicate rule id,
 * min>max threshold, no signal fields on a rule).
 *
 * `reason` carries the one-line diagnostic; `copyTarget` is the shipped
 * default path so the user-facing message can cite the canonical shape.
 *
 * (Story 4.9 Task 2 / FR40a)
 */
export class MalformedRiskTieringSpecError extends DomainError {
  readonly sourcePath: string;
  readonly reason: string;
  readonly copyTarget: string;

  constructor(opts: { sourcePath: string; reason: string; copyTarget: string }) {
    super(
      `docs/risk-tiering.md at ${opts.sourcePath} is malformed: ${opts.reason}. ` +
        `See the canonical shape in ${opts.copyTarget}. (FR40a)`,
    );
    this.sourcePath = opts.sourcePath;
    this.reason = opts.reason;
    this.copyTarget = opts.copyTarget;
  }
}

/**
 * Both the target-repo override and the shipped default for `docs/risk-tiering.md`
 * are absent. This indicates a broken plugin install — the shipped default should
 * always be present in `plugins/crew/docs/risk-tiering.md`.
 *
 * Distinct from `MalformedRiskTieringSpecError` so callers (Story 4.9b) can
 * tell the two failure modes apart and surface different recovery instructions.
 *
 * (Story 4.9 Task 2 / FR40a)
 */
export class ShippedRiskTieringDefaultMissingError extends DomainError {
  readonly expectedPath: string;

  constructor(opts: { expectedPath: string }) {
    super(
      `Shipped risk-tiering default not found at ${opts.expectedPath}. ` +
        `This is a plugin-install bug; please file an issue. (FR40a)`,
    );
    this.expectedPath = opts.expectedPath;
  }
}

/**
 * `computeAgreement` was called with an invalid `lastNVerdicts` value — zero,
 * negative, non-integer, `NaN`, or `Infinity`. Raised BEFORE any filesystem
 * read so the caller receives a rich, actionable message rather than a generic
 * Zod error.
 *
 * Story 4.10 (FR67).
 */
export class AgreementWindowInvalidError extends DomainError {
  readonly lastNVerdicts: number;
  readonly reason: string;

  constructor(opts: { lastNVerdicts: number; reason: string }) {
    super(
      `computeAgreement: invalid lastNVerdicts=${opts.lastNVerdicts} — ${opts.reason}. (FR67)`,
    );
    this.lastNVerdicts = opts.lastNVerdicts;
    this.reason = opts.reason;
  }
}

/**
 * `postReviewerComments` found `reviewer-result.json` but its
 * `standardsVersion` field is absent or empty. Raised instead of emitting
 * a malformed `reviewer.verdict` event — structurally impossible post-4.7
 * but pinned as a hard guard.
 *
 * Story 4.12 (FR66).
 */
export class ReviewerResultMissingStandardsVersionError extends DomainError {
  readonly sessionUlid: string;

  constructor(opts: { sessionUlid: string }) {
    super(
      `reviewer-result.json for session ${opts.sessionUlid} missing required ` +
        `standardsVersion field; cannot emit reviewer.verdict event. (FR66)`,
    );
    this.sessionUlid = opts.sessionUlid;
  }
}

/**
 * `runAutoMergeGate` was called with a `thresholdOverride` value that is
 * outside the valid range `[0, 1]`, is `NaN`, or is non-finite.
 *
 * The caller-supplied override bypasses the workspace-config read entirely
 * (test-seam only), so validation must be strict — a mis-typed value should
 * never silently promote a PR that didn't meet the threshold.
 *
 * Story 4.10b (FR40).
 */
export class AutoMergeGateThresholdInvalidError extends DomainError {
  readonly threshold: number;
  readonly reason: string;

  constructor(opts: { threshold: number; reason: string }) {
    super(
      `runAutoMergeGate: invalid threshold=${opts.threshold} — ${opts.reason}. (FR40)`,
    );
    this.threshold = opts.threshold;
    this.reason = opts.reason;
  }
}

/**
 * `processReviewerTranscript` found `reviewer-result.json` absent for the
 * session — the reviewer subagent completed without ever calling
 * `runReviewerSession`. This is a structural enforcement error (Story 5.21):
 * the reviewer cycle MUST NOT progress to a verdict when `runReviewerSession`
 * was never invoked.
 *
 * The in-progress manifest is stamped with `blocked_by: "reviewer-no-session-result"`
 * before this error is thrown. The inner cycle must surface the error to the
 * operator and halt — it must NOT loop into the outer claim cycle.
 *
 * Deterministic seam (Story 5.21): this typed error replaces the previous
 * soft `done-blocked-no-session-result` return variant. The error class name
 * makes the missing-call mandatory failure undeniable and searchable in
 * call-sites and logs.
 *
 * Story 5.21 — reviewer first-tool-call deterministic seam.
 * Seam implementation: `processReviewerTranscript` in
 * `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`.
 */
export class ReviewerFirstCallSkippedError extends DomainError {
  readonly sessionUlid: string;
  readonly ref: string;

  constructor(opts: { sessionUlid: string; ref: string }) {
    super(
      `reviewer-result.json absent for session ${opts.sessionUlid} (story ${opts.ref}). ` +
        `The reviewer subagent completed without invoking runReviewerSession — ` +
        `the mandatory first-call seam was skipped. ` +
        `The in-progress manifest has been stamped blocked_by: reviewer-no-session-result. ` +
        `Operator must inspect the reviewer transcript before re-running /crew:start. ` +
        `(Story 5.21 — reviewer-first-call-seam)`,
    );
    this.sessionUlid = opts.sessionUlid;
    this.ref = opts.ref;
  }
}

/**
 * `runReviewerSession` failed to fetch the PR's head ref via `gh pr view`.
 * Thrown on any `gh` failure (recoverable or otherwise) during the
 * head-ref fetch step (AC1 / AC4 of Story 5.26).
 *
 * The reviewer session MUST NOT fall back to the local filesystem — it halts
 * immediately and surfaces this error verbatim to the inner cycle caller.
 *
 * Fields:
 * - `prNumber`          — the PR number that was being fetched.
 * - `ghSubcommand`      — the kebab-cased gh subcommand that failed (e.g. `"pr-view"`).
 * - `underlyingMessage` — the raw error message from the gh wrapper.
 *
 * Story 5.26 — reviewer artifact-check against PR branch.
 */
export class ReviewerPrBranchFetchError extends DomainError {
  readonly prNumber: number;
  readonly ghSubcommand: string;
  readonly underlyingMessage: string;

  constructor(opts: {
    prNumber: number;
    ghSubcommand: string;
    underlyingMessage: string;
  }) {
    super(
      `runReviewerSession: failed to fetch head ref for PR #${opts.prNumber} ` +
        `via 'gh ${opts.ghSubcommand}': ${opts.underlyingMessage}. ` +
        `The reviewer session has been halted — do NOT fall back to the local filesystem. ` +
        `(Story 5.26 AC4)`,
    );
    this.prNumber = opts.prNumber;
    this.ghSubcommand = opts.ghSubcommand;
    this.underlyingMessage = opts.underlyingMessage;
  }
}

/**
 * `reattachOrphan` was called on a manifest whose `claimed_by` already matches
 * the current session ULID. This is a race condition where the orphan was
 * claimed by another concurrent step between the scan and the rewrite attempt.
 *
 * Story 5.11 Task 2.2.
 */
export class NotAnOrphanError extends DomainError {
  readonly ref: string;
  readonly currentSessionUlid: string;

  constructor(opts: { ref: string; currentSessionUlid: string }) {
    super(
      `reattach-orphan refused: '${opts.ref}' is already claimed by the current session ` +
        `'${opts.currentSessionUlid}' — it is not an orphan. ` +
        `This is typically a race between scanOrphanedInProgress and reattachOrphan. ` +
        `(Story 5.11)`,
    );
    this.ref = opts.ref;
    this.currentSessionUlid = opts.currentSessionUlid;
  }
}

/**
 * A story retro payload (the argument to `recordStoryRetro`) failed schema
 * validation: malformed shape, unknown key (strict-mode rejection), invalid
 * `kind` value (closed enum), missing `failure_class` on a `pitfall` lesson,
 * or `duration_seconds` not a non-negative integer.
 *
 * Mirrors `MalformedExecutionManifestError`'s shape. Named so the MCP
 * boundary maps Zod failures to a typed envelope.
 *
 * Thrown by `parseStoryRetroPayload` in
 * `schemas/story-retro.ts` — every caller MUST go through that helper.
 * (Story 6.1 AC2, FR11)
 */
export class MalformedStoryRetroPayloadError extends DomainError {
  readonly yamlPath: string;
  readonly zodMessage: string;
  readonly schemaModule: string;

  constructor(opts: {
    yamlPath: string;
    zodMessage: string;
    schemaModule: string;
  }) {
    super(
      `Story retro payload is malformed at '${opts.yamlPath}': ${opts.zodMessage}. ` +
        `See ${opts.schemaModule} for the canonical schema.`,
    );
    this.yamlPath = opts.yamlPath;
    this.zodMessage = opts.zodMessage;
    this.schemaModule = opts.schemaModule;
  }
}

/**
 * `recordStoryRetro` refused to attach a retro payload because the target
 * manifest is not in `done/`. The state-guard says retros are a
 * post-completion concern — attaching a retro to a `to-do/`, `blocked/`,
 * or `in-progress/` manifest is a structural error.
 *
 * `foundIn` carries the actual state directory where the manifest was
 * located (one of `"to-do"`, `"blocked"`, `"in-progress"`). If the
 * manifest does not exist anywhere, `recordStoryRetro` throws
 * `ManifestNotFoundError` instead.
 *
 * Story 6.1 AC1, FR55.
 */
export class StoryNotInDoneStateError extends DomainError {
  readonly ref: string;
  readonly foundIn: "to-do" | "blocked" | "in-progress";

  constructor(opts: {
    ref: string;
    foundIn: "to-do" | "blocked" | "in-progress";
  }) {
    super(
      `recordStoryRetro refused: '${opts.ref}' is not in done/ — found in '${opts.foundIn}/'. ` +
        `Retros are a post-completion concern; only completed manifests can carry retro entries. ` +
        `Either complete the story first or, if it is permanently blocked, do not record a retro. ` +
        `(Story 6.1)`,
    );
    this.ref = opts.ref;
    this.foundIn = opts.foundIn;
  }
}

/**
 * A retro proposal (or the file-level wrapper) failed Zod schema validation —
 * unknown discriminator literal, missing required field for a variant, path
 * traversal in a `skill-create`/`skill-revise` `proposed_path`, malformed ULID
 * `id`, non-UTC `created_at`, etc.
 *
 * Mirrors `MalformedExecutionManifestError`'s shape. Named so the MCP boundary
 * maps Zod failures to a typed envelope downstream tooling (Epic 6b's apply
 * paths) can pattern-match against.
 *
 * Thrown by `parseRetroProposalFile` in `schemas/retro-proposal.ts` — every
 * caller MUST go through that helper.
 *
 * (Story 6.3 AC2 / FR59)
 */
export class MalformedRetroProposalError extends DomainError {
  readonly yamlPath: string;
  readonly zodMessage: string;
  readonly schemaModule: string;

  constructor(opts: {
    yamlPath: string;
    zodMessage: string;
    schemaModule: string;
  }) {
    super(
      `Retro proposal payload is malformed at '${opts.yamlPath}': ${opts.zodMessage}. ` +
        `See ${opts.schemaModule} for the canonical schema.`,
    );
    this.yamlPath = opts.yamlPath;
    this.zodMessage = opts.zodMessage;
    this.schemaModule = opts.schemaModule;
  }
}

/**
 * `acceptProposal`'s id locator scanned every `.crew/retro-proposals/*.md`
 * file and found no proposal whose `id` matches the requested id. Names
 * the id and how many files were scanned so the operator can tell an
 * empty/absent proposals dir apart from a genuine miss.
 *
 * (Story 6.4 AC1)
 */
export class ProposalNotFoundError extends DomainError {
  readonly proposalId: string;
  readonly filesScanned: number;

  constructor(opts: { proposalId: string; filesScanned: number }) {
    super(
      `No retro proposal with id '${opts.proposalId}' found ` +
        `(scanned ${opts.filesScanned} proposal file${opts.filesScanned === 1 ? "" : "s"} ` +
        `under .crew/retro-proposals/). Check the id against the proposal markdown file, ` +
        `or run /crew:retro to produce proposals first. (Story 6.4 AC1)`,
    );
    this.proposalId = opts.proposalId;
    this.filesScanned = opts.filesScanned;
  }
}

/**
 * `acceptProposal`'s id locator found the same proposal id in two distinct
 * proposal files. Proposal ids are minted unique (ULIDs), so a collision is
 * a bug — never a silent pick-first. Names both files so the operator can
 * remove or fix the duplicate.
 *
 * (Story 6.4 AC1)
 */
export class AmbiguousProposalIdError extends DomainError {
  readonly proposalId: string;
  readonly matchingFiles: readonly string[];

  constructor(opts: { proposalId: string; matchingFiles: readonly string[] }) {
    super(
      `Proposal id '${opts.proposalId}' matched in multiple proposal files: ` +
        `[${opts.matchingFiles.join(", ")}]. Proposal ids are minted unique — ` +
        `a collision is a bug, not a legitimate pick-first. Remove or fix the ` +
        `duplicate. (Story 6.4 AC1)`,
    );
    this.proposalId = opts.proposalId;
    this.matchingFiles = [...opts.matchingFiles];
  }
}

/**
 * `acceptProposal` dispatched a located proposal to the handler registry but
 * found no registered handler for the proposal's kind. Each kind maps to the
 * story that will ship its apply path so the message is actionable. Raised
 * BEFORE any preview is rendered or any state is touched — the gate fails
 * closed rather than half-applying an un-handled kind.
 *
 * In this story (6.4) the production registry is empty by design — every
 * kind fails closed here. The first real handler arrives in Story 6.5.
 *
 * (Story 6.4 AC6)
 */
export class ProposalKindNotApplicableYetError extends DomainError {
  readonly kind: string;
  readonly story: string;

  constructor(opts: { kind: string; story: string }) {
    super(
      `Accepting a proposal of kind '${opts.kind}' is not supported yet — ` +
        `its apply path ships in ${opts.story}. No file was written, no commit ` +
        `was made, and the proposal was not stamped. (Story 6.4 AC6)`,
    );
    this.kind = opts.kind;
    this.story = opts.story;
  }
}

/**
 * `writeRetroProposal` refused to overwrite an existing proposal file —
 * proposals are immutable artifacts keyed by their ISO-8601 timestamp.
 * A collision means the caller (the retro-analyst subagent) re-used a
 * timestamp from a prior cycle, which is a bug in the caller, not a
 * legitimate retry surface.
 *
 * (Story 6.3 AC1 / FR58)
 */
export class RetroProposalAlreadyExistsError extends DomainError {
  readonly absPath: string;
  readonly isoTimestamp: string;

  constructor(opts: { absPath: string; isoTimestamp: string }) {
    super(
      `writeRetroProposal refused: a proposal already exists at '${opts.absPath}' ` +
        `(isoTimestamp='${opts.isoTimestamp}'). Proposals are immutable — collisions ` +
        `indicate the caller re-used a timestamp. (Story 6.3 AC1)`,
    );
    this.absPath = opts.absPath;
    this.isoTimestamp = opts.isoTimestamp;
  }
}

/**
 * `materialiseDevStoryWorktree` failed to stand up the dev's isolated worktree
 * on the drain path. Raised on a non-zero `git status` (snapshotting the dev's
 * changed paths) or a failed `git worktree add` — both are structural failures
 * that must halt the dev step rather than silently fall back to committing in
 * the orchestrating checkout.
 *
 * (Story 8.16)
 */
export class DevStoryWorktreeError extends DomainError {
  readonly ref: string;
  readonly phase: "status" | "worktree-add";
  readonly underlyingMessage: string;

  constructor(opts: {
    ref: string;
    phase: "status" | "worktree-add";
    underlyingMessage: string;
  }) {
    super(
      `materialiseDevStoryWorktree: failed to isolate the dev's worktree for ` +
        `'${opts.ref}' at phase '${opts.phase}': ${opts.underlyingMessage}. ` +
        `The dev step has been halted — it must not fall back to committing in ` +
        `the orchestrating checkout. (Story 8.16)`,
    );
    this.ref = opts.ref;
    this.phase = opts.phase;
    this.underlyingMessage = opts.underlyingMessage;
  }
}

/**
 * `markStoryReady` refused because the named reference is not an un-claimed
 * backlog item. The readiness brake (Story 9.1) only applies to items that
 * are still in `to-do/` and not withdrawn — once a story has been claimed
 * (`in-progress/`), completed (`done/`), blocked, or withdrawn, toggling its
 * readiness is meaningless and would risk entangling the flag with the
 * status state-machine.
 *
 * Mirrors the not-an-eligible-item guard polarity of the withdraw path: the
 * operator may only bless or un-bless work that is genuinely waiting at the
 * intake gate. Thrown BEFORE any write — the manifest is never mutated on
 * this path, and no telemetry event is emitted.
 *
 * `foundState` is the state directory the ref WAS found in (when it exists),
 * or `null` when the ref does not exist in any state directory at all, so
 * the operator gets a precise reason.
 *
 * Story 9.1 — Epic 9 intake cockpit.
 */
export class NotAnEligibleBacklogItemError extends DomainError {
  readonly ref: string;
  readonly foundState: string | null;
  readonly reason: "not-found" | "not-in-to-do" | "withdrawn";

  constructor(opts: {
    ref: string;
    foundState: string | null;
    reason: "not-found" | "not-in-to-do" | "withdrawn";
  }) {
    const detail =
      opts.reason === "not-found"
        ? `no manifest for '${opts.ref}' exists in any state directory`
        : opts.reason === "withdrawn"
          ? `'${opts.ref}' has been withdrawn and is not an admissible backlog item`
          : `'${opts.ref}' is in state '${opts.foundState}', not 'to-do' — readiness ` +
            `can only be toggled on an un-claimed backlog item`;
    super(
      `markStoryReady refused: ${detail}. The readiness brake only applies to ` +
        `un-claimed backlog items waiting in to-do/. (Story 9.1)`,
    );
    this.ref = opts.ref;
    this.foundState = opts.foundState;
    this.reason = opts.reason;
  }
}

/**
 * `writeNativeStory` refused to write a candidate story because it violated one
 * or more authoring-time planning-discipline rules (Story 3.5 rules, e.g. a
 * state-mutating story with no integration AC, or an undeclared cross-story
 * reference).
 *
 * This is the fail-closed write-gate hardening of Story 9.2: the discipline
 * check moved INTO the write tool, so a violating story can no longer be
 * written even by a direct caller that skipped the planner's pre-write
 * `validatePlannerBacklog` step. The guarantee no longer rests on the author
 * subagent's prose — it lives in the tool layer.
 *
 * Thrown BEFORE any filesystem write: no native-story file appears on disk on
 * this path, and no `draft.authored` telemetry event is emitted. The caller
 * (the author subagent / the `/crew:author` skill) surfaces `violations` back
 * to the operator for the refuse-and-revise loop.
 *
 * `violations` mirrors the `DisciplineViolationReason[]` shape returned by
 * `validateStoryAgainstDiscipline`, so callers can read the machine-checkable
 * `code`/`field`/`detail` of every violation without parsing the message.
 *
 * Story 9.2 — author seam (fail-closed discipline gate).
 */
export class DisciplineViolationError extends DomainError {
  readonly violations: ReadonlyArray<{ code: string; field: string; detail: string }>;

  constructor(opts: {
    violations: ReadonlyArray<{ code: string; field: string; detail: string }>;
  }) {
    const codes = opts.violations.map((v) => v.code).join(", ");
    const details = opts.violations
      .map((v) => `- [${v.code}] (${v.field}) ${v.detail}`)
      .join("\n");
    super(
      `writeNativeStory refused: candidate story violates planning-discipline ` +
        `rule(s): [${codes}]. No story file was written. Revise the feature framing ` +
        `and retry:\n${details} (Story 9.2)`,
    );
    this.violations = opts.violations;
  }
}

/**
 * The judge panel (Story 9.3) could not grade a Tier-1 lens because no role was
 * supplied to judge it.
 *
 * This is the rubber-stamp failure in disguise: a missing lens must FAIL LOUDLY,
 * never be silently dropped while the panel reports a clean sweep. Lens diversity
 * is non-negotiable (rubric §3) — every one of the five Tier-1 lenses must be
 * graded by a distinct judge role.
 *
 * Thrown before any verdict file is read or any panel verdict is assembled.
 *
 * Story 9.3 — judge panel.
 */
export class LensJudgeUnavailableError extends DomainError {
  readonly lens: string;

  constructor(opts: { lens: string }) {
    super(
      `Judge panel cannot grade the '${opts.lens}' lens: no judging role was ` +
        `supplied for it. A missing lens is the rubber-stamp failure in disguise — ` +
        `every Tier-1 lens (structure, verifiability, discipline, domain, considered) ` +
        `must be graded by a distinct role. Hire / supply a role for '${opts.lens}' ` +
        `and re-run the panel. (Story 9.3)`,
    );
    this.lens = opts.lens;
  }
}

/**
 * Two or more Tier-1 lenses were bound to the SAME judging role.
 *
 * Lens diversity is structural, not advisory (rubric §3): a panel that shares a
 * judge across lenses re-opens the rubber-stamp risk. The panel refuses to run
 * rather than grade with a degenerate roster.
 *
 * Story 9.3 — judge panel.
 */
export class DuplicateLensJudgeError extends DomainError {
  readonly role: string;
  readonly lenses: string[];

  constructor(opts: { role: string; lenses: string[] }) {
    super(
      `Judge panel refuses to run: role '${opts.role}' is bound to more than one ` +
        `lens [${opts.lenses.join(", ")}]. Lens diversity is non-negotiable — no two ` +
        `lenses may share a judge, or the panel rubber-stamps the author's blind spots. ` +
        `Bind a distinct role to each lens. (Story 9.3)`,
    );
    this.role = opts.role;
    this.lenses = opts.lenses;
  }
}

/**
 * A lens judge's per-lens verdict file is absent, unparseable, fails
 * `LensVerdictSchema`, or disagrees with the lens / role the panel asked it to
 * grade (e.g. a fail with an empty `missed`, the wrong `lens`, or the wrong
 * `role`).
 *
 * The panel consumes FILES, never transcripts (deterministic-seam discipline).
 * A judge that did not write a well-formed verdict file is treated as a hard
 * failure, not a silent pass — a malformed verdict would otherwise let a thin
 * draft slip through the gate.
 *
 * Story 9.3 — judge panel.
 */
export class LensVerdictFileMalformedError extends DomainError {
  readonly lens: string;
  readonly path: string;
  readonly reason: string;

  constructor(opts: { lens: string; path: string; reason: string }) {
    super(
      `Lens-verdict file for the '${opts.lens}' lens at ${opts.path} is missing or ` +
        `malformed: ${opts.reason}. The panel reads files, not transcripts — a judge ` +
        `that did not write a well-formed {lens, role, pass, missed} verdict (e.g. a ` +
        `fail with an empty 'missed') is a hard failure, never a silent pass. (Story 9.3)`,
    );
    this.lens = opts.lens;
    this.path = opts.path;
    this.reason = opts.reason;
  }
}

/**
 * `recordSkillInvoke` was called with an input payload that failed schema
 * validation — a missing/empty `data` field, or a closed-enum violation on
 * `skill_scope` / `invocation_source`. The closed enums are intentional: an
 * unknown scope or source is a bug, not something to fall through (the "no
 * silent fallback" discipline). No `skill.invoke` event is written when this
 * throws (the bad event never reaches the logger).
 *
 * Story 6.8.
 */
export class MalformedSkillInvokeInputError extends DomainError {
  readonly zodPath: string;
  readonly zodMessage: string;

  constructor(opts: { zodPath: string; zodMessage: string }) {
    super(
      `recordSkillInvoke: input failed schema validation at '${opts.zodPath}': ` +
        `${opts.zodMessage}. skill_scope (project|persona|plugin) and ` +
        `invocation_source (user-slash-command|agent-call) are closed enums — an ` +
        `unknown value is rejected, never coerced. No skill.invoke event was written. ` +
        `(Story 6.8)`,
    );
    this.zodPath = opts.zodPath;
    this.zodMessage = opts.zodMessage;
  }
}

/**
 * A `skill-create` (or `skill-supersede` replacement) apply handler refused
 * because a file already exists at the proposed skill path. Skill creation
 * never overwrites — a collision means the operator is trying to create a
 * skill that already lives at that path; they should revise or supersede it
 * instead. Thrown BEFORE any write so the working tree is left untouched.
 *
 * Story 6.7 — skill proposal application.
 */
export class SkillAlreadyExistsError extends DomainError {
  readonly skillPath: string;

  constructor(opts: { skillPath: string }) {
    super(
      `Cannot create a skill at '${opts.skillPath}' — a file already exists there. ` +
        `Skill creation never overwrites; revise or supersede the existing skill ` +
        `instead. No file was written. (Story 6.7)`,
    );
    this.skillPath = opts.skillPath;
  }
}

/**
 * `computeSkillEffectiveness` was called with a `window` value that is not a
 * positive integer (`0`, negative, non-integer, `NaN`, or non-finite). The
 * window bounds which most-recent `skill.invoke` events are considered; a
 * mis-typed value should never silently widen or empty the sample.
 *
 * Story 6.8 (mirrors `AgreementWindowInvalidError`).
 */
export class SkillEffectivenessWindowInvalidError extends DomainError {
  readonly window: number;
  readonly reason: string;

  constructor(opts: { window: number; reason: string }) {
    super(
      `computeSkillEffectiveness: invalid window=${opts.window} — ${opts.reason}. ` +
        `(Story 6.8)`,
    );
    this.window = opts.window;
    this.reason = opts.reason;
  }
}

/**
 * A `skill-revise`, `skill-retire`, or `skill-supersede` apply handler refused
 * because the targeted skill file does not exist at the live path. You cannot
 * revise, retire, or supersede a skill that was never created (or has already
 * been archived). Thrown BEFORE any write so the working tree is left
 * untouched.
 *
 * Story 6.7 — skill proposal application.
 */
export class SkillNotFoundError extends DomainError {
  readonly skillPath: string;

  constructor(opts: { skillPath: string }) {
    super(
      `Cannot apply a skill change targeting '${opts.skillPath}' — no skill file ` +
        `exists at that path. It may never have been created or may already be ` +
        `archived. No file was written. (Story 6.7)`,
    );
    this.skillPath = opts.skillPath;
  }
}

/**
 * `regenerate-standards` would project more than the hard cap of criteria
 * from the current rule registry. The apply handler raises this BEFORE writing
 * `docs/standards.md` and the caller (the `rule`-apply handler) is responsible
 * for rolling back the registry to its pre-append snapshot so the working tree
 * is left byte-identical to its pre-accept state.
 *
 * `criteriaCount` is the number of criteria the projection WOULD produce (the
 * number that exceeds the cap); `cap` is the hard limit read from
 * `StandardsDocSchema` (currently `10`, FR46).
 *
 * Mirrors `StandardsDocMalformedError`'s constructor shape.
 *
 * Story 6.5b — `regenerate-standards` version bump + ≤10-cap re-enforcement.
 */
export class StandardsCapExceededError extends DomainError {
  readonly criteriaCount: number;
  readonly cap: number;

  constructor(opts: { criteriaCount: number; cap: number }) {
    super(
      `regenerate-standards refused: the rule registry projects ${opts.criteriaCount} ` +
        `criteria, exceeding the hard cap of ${opts.cap} (FR46). ` +
        `Retire or replace an existing rule before adding a new one. ` +
        `No file was written; the registry has been restored to its pre-accept state. ` +
        `(Story 6.5b)`,
    );
    this.criteriaCount = opts.criteriaCount;
    this.cap = opts.cap;
  }
}
