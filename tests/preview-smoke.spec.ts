import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Smoke tests for a deployed PR preview environment.
 *
 * Asserts the preview login gate (preview-auth.middleware) behaves per role and
 * that core pages render for users who pass it. Runs only under
 * playwright.preview.config.ts (needs PREVIEW_URL + the minted storage states).
 */

// Core pages every gate-passing user should be able to load.
const CORE_PAGES = ['/', '/models', '/images'];

// Roles that MUST clear the gate (mod via code, tester/gold via Flipt allowlist).
const ALLOWED_ROLES = ['mod', 'tester', 'gold'] as const;

for (const role of ALLOWED_ROLES) {
  test.describe(`gate passes for ${role}`, () => {
    test.use({ storageState: storageStatePath(role) });

    for (const path of CORE_PAGES) {
      test(`${role} loads ${path}`, async ({ page }) => {
        const resp = await page.goto(path, { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), `HTTP status for ${path}`).toBeLessThan(400);
        // Not bounced to either gate destination.
        expect(page.url(), 'should not redirect to /login').not.toContain('/login');
        expect(page.url(), 'should not redirect to /preview-restricted').not.toContain(
          '/preview-restricted'
        );
      });
    }
  });
}

test.describe('gate denies a logged-in non-tester', () => {
  test.use({ storageState: storageStatePath('restricted') });

  test('restricted user is redirected to /preview-restricted', async ({ page }) => {
    await page.goto('/models', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/preview-restricted/);
  });
});

test.describe('gate denies anonymous', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('anonymous user is redirected to /login', async ({ page }) => {
    await page.goto('/models', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login/);
  });
});
