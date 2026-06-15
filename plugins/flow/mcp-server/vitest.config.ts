import { defineConfig } from "vitest/config";

// CI gets the proven, faster settings; a developer machine (where the run's
// per-story pre-PR test gate runs) gets a hard-bounded footprint so a runaway
// run can never drag the box into swap. GitHub Actions sets `CI`.
const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Bound peak memory of a test run. Vitest defaults to one fork (a separate
    // process) per CPU core, and each fork inherits the `test` script's large
    // `--max-old-space-size`, so on a many-core machine a single run can spawn
    // ~10–19 heavy processes at once — fine on a CI runner (≤4 cores), but it
    // starved a developer machine into a hard reboot mid-run.
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        // Fewer concurrent fork processes off CI.
        maxForks: isCI ? 4 : 2,
        // Off CI, also cap EACH fork's heap (overrides the larger ceiling the
        // `test` script's NODE_OPTIONS inherits) so a runaway fork hits a clean
        // OOM — the gate fails recoverably — instead of exhausting machine RAM.
        // CI keeps the script's ceiling (proven green) by omitting execArgv.
        ...(isCI ? {} : { execArgv: ["--max-old-space-size=2048"] }),
      },
    },
    coverage: {
      // Use v8 built-in instrumentation — no source transforms needed.
      provider: "v8",
      // 'text' prints the summary to the console; 'json-summary' writes
      // coverage/coverage-summary.json for downstream tooling.
      reporter: ["text", "json-summary"],
      // Do NOT set all:true — that would enumerate every source file and
      // fail the run on files with zero coverage, violating AC3.
      // Zero-coverage files appear in the report when a test imports them;
      // they are a review lens, not an automatic gate.
      all: false,
      // Non-regression thresholds committed from the first baseline run
      // (2026-06-14, native:01KT7RPCNQJGYBR8V0XSFHVRKP). Any PR that drops
      // below these numbers will fail the coverage step in CI.
      // To update: run `pnpm test:coverage`, read the console percentages,
      // and commit the new numbers here.
      // Thresholds are the floor of the measured values (e.g. 86.97 -> 86)
      // so the gate catches real regressions without being brittle to
      // single-decimal noise between CI and developer machines.
      thresholds: {
        lines: 86,
        branches: 85,
      },
    },
  },
});
