import { defineConfig, devices } from '@playwright/test'

// Select framework via E2E_FRAMEWORK env var (default: vue)
const framework = process.env.E2E_FRAMEWORK || 'react'

const frameworkConfig: Record<string, { cwd: string; port: number; testMatch?: string }> = {
  vue: {
    cwd: '../../examples/vue-filesync',
    port: 60004,
  },
  react: {
    cwd: '../../examples/react-filesync',
    port: 60004,
  },
  thumbnail: {
    cwd: '../../examples/vue-thumbnail',
    port: 60005,
    testMatch: '**/thumbnail.spec.ts',
  },
  'vue-thumbnail': {
    cwd: '../../examples/vue-thumbnail',
    port: 60005,
    testMatch: '**/thumbnail.spec.ts',
  },
  'react-thumbnail': {
    cwd: '../../examples/react-thumbnail',
    port: 60006,
    testMatch: '**/thumbnail.spec.ts',
  },
}

const config = frameworkConfig[framework]
if (!config) {
  throw new Error(`Unknown framework: ${framework}. Use 'vue', 'react', 'thumbnail', 'vue-thumbnail', or 'react-thumbnail'.`)
}

export default defineConfig({
  testDir: './tests',
  testMatch: config.testMatch,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: `http://localhost:${config.port}`,
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
      // Firefox has timing issues with Effect runtime under parallel load
      // that can cause the SyncExecutor worker loop to stall. Allow retries.
      retries: 2,
    },
  ],

  webServer: {
    command: 'pnpm run dev',
    url: `http://localhost:${config.port}`,
    reuseExistingServer: !process.env.CI,
    cwd: config.cwd,
    timeout: 120000,
  },
})
