import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    // Test files run one after another, not side by side. Every file that
    // touches the database truncates every table before each test, so two
    // such files running at once would wipe each other's rows mid-test.
    fileParallelism: false,
  },
});
