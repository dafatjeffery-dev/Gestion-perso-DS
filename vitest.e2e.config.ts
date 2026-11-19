import { defineConfig } from 'vitest/config';

// Tests de l'interface dans Chromium, sur l'APERÇU NAVIGATEUR (build Vite).
// Ils ne valident pas l'application Mac compilée.
export default defineConfig({
  test: { include: ['tests/e2e/**/*.e2e.ts'], testTimeout: 60000, hookTimeout: 120000, fileParallelism: false },
});
