import { test, expect } from '@playwright/test';

test('Verify localized page load', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example Domain/);
  const header = page.locator('h1');
  await expect(header).toBeVisible();
});
