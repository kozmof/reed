import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/perf.test.ts"],
    coverage: {
      provider: "v8",
      // Enumerate all production modules, including files no test imports.
      // Without include, thresholds only cover modules executed by the suite.
      include: ["src/**/*.ts"],
      // Test data/helpers and benchmarks under test-utils are not product code;
      // don't gate them on product coverage thresholds.
      exclude: [...coverageConfigDefaults.exclude, "src/**/*.test.ts", "test-utils/**"],
      // Per-file gates sit ~1.5 pts under the current per-file floor (the
      // worst-covered file per metric, not the aggregate): statements and lines
      // are bounded by line-index.ts (~79% / ~81%), branches by rendering.ts
      // (~74%), functions by chunk-manager.ts (~83%).
      // Tightening these further requires lifting coverage of those files.
      //
      // statements/lines were lowered by 2 points in v3.2.0, when line-index
      // deletion moved onto the shared primitives in rb-tree.ts. That removed
      // 51 statements from line-index.ts, 49 of which were covered, so its
      // ratio fell while its absolute uncovered count went *down* (91 -> 89)
      // and whole-project coverage rose. The floor tracks the file's new
      // composition; it is not a regression in tested behaviour.
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
