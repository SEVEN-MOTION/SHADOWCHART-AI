import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120000,          // Global test timeout: 2 minutes
  expect: { timeout: 10000 }, // Assertions timeout: 10 seconds
  fullyParallel: false,     // Single line workflow sequence
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,               // Single runner matrix isolation
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Use system memory loop instead of /dev/shm pool limits
            '--disable-gpu',
            '--font-render-hinting=none'
          ]
        }
      },
    }
  ],
});
