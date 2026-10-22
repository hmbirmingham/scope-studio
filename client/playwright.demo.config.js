import { defineConfig, devices } from '@playwright/test';

// The student demo, end to end: `npm run demo` started for real (preflight,
// database, seed, engine, built app) with the scripted demo model in place of
// Ollama's chat (server/test/demoE2e.js), then e2e/demo.spec.js walks the
// talk track in docs/demo.md in a real Chromium and saves a screenshot of
// each step. Needs Postgres with pgvector and a database it may reset:
//
//   DEMO_DATABASE_URL=postgresql://localhost:5432/scope_demo_test npx playwright test -c playwright.demo.config.js
//
// DEMO_SHOTS_DIR, if set, also receives the screenshots.
const CLIENT_PORT = Number(process.env.DEMO_CLIENT_PORT || 5183);
const ENGINE_PORT = Number(process.env.DEMO_ENGINE_PORT || 3011);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'demo.spec.js',
  timeout: 120_000,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: {
    command: 'node ../server/test/demoE2e.js',
    url: `http://localhost:${CLIENT_PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    env: { DEMO_CLIENT_PORT: String(CLIENT_PORT), DEMO_ENGINE_PORT: String(ENGINE_PORT), DEMO_NO_OPEN: '1' },
    // The launcher stops the engine and the app itself, which a plain kill of
    // its process group would not reach.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
});
