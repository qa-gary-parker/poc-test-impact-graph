import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'record.demo.ts',
  outputDir: './out/test-results',
  timeout: 3_000_000,
  workers: 1,
  reporter: 'list',
  use: { viewport: { width: 1920, height: 1080 } },
});
