import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/perf.test.ts'],
    coverage: {
      provider: 'v8'
    }
  },
});
