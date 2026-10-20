import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound CPU contention so invariant-heavy tests stay within their timeout.
    maxWorkers: 4,
    exclude: [...configDefaults.exclude, "**/perf.test.ts"],
    coverage: {
      provider: "v8",
      // Enumerate all production modules, including files no test imports.
      // Without include, thresholds only cover modules executed by the suite.
      include: ["src/**/*.ts"],
      // Apply product coverage thresholds to production modules. Exclude test
      // helpers and benchmarks under test-utils.
      exclude: [...coverageConfigDefaults.exclude, "src/**/*.test.ts", "test-utils/**"],
      // Enforce coverage thresholds for each production file. Improve the
      // lowest-covered files before raising these thresholds.
      //
      // The statement and line thresholds fell by two points in v3.2.0 after
      // deletion logic moved from line-index.ts to shared rb-tree.ts helpers.
      // Removing mostly covered code lowered the file's coverage percentage
      // even though fewer statements remained uncovered.
      thresholds: {
        statements: 78,
        branches: 72,
        functions: 82,
        lines: 80,
        perFile: true,
      },
    },
  },
});
