import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/perf.test.ts"],
    coverage: {
      provider: "v8",
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
