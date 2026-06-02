import { type RepoSignals } from "../schemas/repo-signals.js";
export interface ReadRepoSignalsOptions {
    targetRepoRoot: string;
}
/**
 * Return a typed `RepoSignals` payload describing the target repo at a
 * high level (Story 2.4, FR85). The hiring manager subagent consumes
 * this as initial context to drive a project-shaped team proposal.
 *
 * Best-effort downgrades: missing README (ENOENT) → `readmeExcerpt = ""`;
 * `git log` non-zero exit (no git, no commits, not a repo) →
 * `recentCommitTitles = []`. Other IO errors propagate — they indicate a
 * misconfigured repo, not "no signal."
 *
 * No telemetry — `readRepoSignals` is a synchronous read-only diagnostic
 * (NFR21).
 */
export declare function readRepoSignals(opts: ReadRepoSignalsOptions): Promise<RepoSignals>;
