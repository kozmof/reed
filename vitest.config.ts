import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/perf.test.ts"],
    coverage: {
      provider: "v8",
      // Test data/helpers and benchmarks under test-utils are not product code;
      // don't gate them on product coverage thresholds.
      exclude: [...coverageConfigDefaults.exclude, "test-utils/**"],
      thresholds: {
        statements: 78,
        branches: 66,
        functions: 69,
        lines: 79,
        perFile: true,
      },
    },
  },
});
