import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/perf.test.ts"],
    coverage: {
      provider: "v8",
      // Test data/helpers and benchmarks under test-utils are not product code;
      // don't gate them on product coverage thresholds.
      exclude: [...coverageConfigDefaults.exclude, "test-utils/**"],
      // Per-file gates sit ~1.5 pts under the current per-file floor (the
      // worst-covered file per metric, not the aggregate): statements are
      // bounded by line-index.ts (~82%), branches by rendering.ts (~74%),
      // functions by chunk-manager.ts (~83%), lines by line-index.ts (~84%).
      // Tightening these further requires lifting coverage of those files.
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 82,
        lines: 83,
        perFile: true,
      },
    },
  },
});
