import { defineConfig, devices } from '@playwright/test'

// Select framework via E2E_FRAMEWORK env var (default: vue)
const framework = process.env.E2E_FRAMEWORK || 'vue'

const frameworkConfig: Record<string, { cwd: string; port: number }> = {
  vue: {
    cwd: '../../examples/vue-filesync',
    port: 60004,
  },
  react: {
    cwd: '../../examples/react-filesync',
    port: 60004,
  },
}

const config = frameworkConfig[framework]
if (!config) {
  throw new Error(`Unknown framework: ${framework}. Use 'vue' or 'react'.`)
}

export default defineConfig({
  testDir: './tests',
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
