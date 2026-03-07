import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/store/features/perf.test.ts'],
  },
});
