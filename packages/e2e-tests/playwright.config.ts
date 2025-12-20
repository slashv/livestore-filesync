import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for livestore-filesync E2E tests.
 *
 * These tests are framework-agnostic and can be run against any
 * implementation (React, Vue, etc.) that follows the expected
 * data-testid conventions.
 *
 * Usage:
 *   # Test against React example
 *   BASE_URL=http://localhost:60003 pnpm test
 *
 *   # Test against Vue example
 *   BASE_URL=http://localhost:60004 pnpm test
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:60003',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  // Don't start a web server - assume it's already running
  // This allows testing against any framework implementation
  webServer: process.env.START_SERVER ? {
    command: process.env.SERVER_COMMAND || 'pnpm dev',
    url: process.env.BASE_URL || 'http://localhost:60003',
    reuseExistingServer: !process.env.CI,
    cwd: process.env.SERVER_CWD || '../../examples/web-filesync',
  } : undefined,
})
