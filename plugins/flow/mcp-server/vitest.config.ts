import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Bound peak memory of a test run. Vitest defaults to one fork (a separate
    // process) per CPU core, and each fork inherits the `test` script's large
    // `--max-old-space-size`, so on a many-core machine a single run can spawn
    // ~10–19 heavy processes at once. That is fine on CI runners (≤4 cores) but
    // starves a developer machine — and the drain's per-story pre-PR test gate
    // runs on the developer machine. Capping the fork pool keeps the gate light;
    // CI is unaffected (it already runs at its core count, which is ≤ this cap).
    pool: "forks",
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
  },
});
