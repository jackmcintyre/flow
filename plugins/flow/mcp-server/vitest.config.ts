import { defineConfig } from "vitest/config";

// CI gets the proven, faster settings; a developer machine (where the drain's
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
    // starved a developer machine into a hard reboot mid-drain.
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
  },
});
