import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: 'list',
  use: { screenshot: 'only-on-failure' },
  webServer: {
    command: 'npx vite --config tests/preview.config.ts --port 5488',
    url: 'http://127.0.0.1:5488',
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: 'electron', testMatch: /native\.spec\.ts/ },
    {
      name: 'chromium',
      testMatch: /renderer\.spec\.ts/,
      use: {
        browserName: 'chromium',
        ...(process.env.VID_STUDIO_CHROME_CHANNEL
          ? { channel: process.env.VID_STUDIO_CHROME_CHANNEL }
          : {}),
        baseURL: 'http://127.0.0.1:5488'
      }
    }
  ]
})
