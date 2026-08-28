import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authDegen } from './auth/data';
import { GEN_SUBMIT_TARGET } from '~/components/Tours/tour-targets';

/**
 * Re-firing a tour means defeating BOTH persistence stores: completion lives in
 * localStorage `tours` AND in `User.settings.tourSettings`, with the server winning.
 * Route-mocking `getSettings` keeps the test off the shared test user's real row,
 * which would otherwise leak between specs and between runs.
 */
const forceFirstRun = async (page: Page) => {
  await page.addInitScript(() => window.localStorage.removeItem('tours'));
  await page.route(/\/api\/trpc\/user\.getSettings(\?|$)/, async (route) => {
    await route.fulfill({ json: { result: { data: { json: { tourSettings: {} } } } } });
  });
};

const tourTooltip = (page: Page) => page.getByRole('alertdialog');

// The welcome tour's second and third steps target the carousel's remix button, which
// only renders for an image the generator can remix. A model without one silently
// reduces the tour to its intro step.
const MODEL_ID = process.env.E2E_TOUR_MODEL_ID ?? '1';

test.describe('guided tours', () => {
  test.use(authDegen);

  test.beforeEach(async ({ page }) => {
    await forceFirstRun(page);
  });

  test('the generator tour opens and can be walked to the end', async ({ page }) => {
    await page.goto('/generate');
    await expect(tourTooltip(page)).toBeVisible();

    for (let i = 0; i < 12; i++) {
      const next = page.getByRole('button', { name: /^(Next|Let's go|Done)$/ });
      if (!(await next.isVisible())) break;
      await next.click();
    }

    await expect(tourTooltip(page)).toBeHidden();
  });

  /**
   * A step whose target is absent used to be indistinguishable from a click on
   * Next: the step vanished, the counter jumped, nothing was recorded. Removing
   * an attribute mid-tour is the only way to reproduce that from outside.
   */
  test('a missing target does not end the tour', async ({ page }) => {
    await page.goto('/generate');
    await expect(tourTooltip(page)).toBeVisible();

    await page.evaluate(() =>
      document.querySelector('[data-tour="gen:prompt"]')?.removeAttribute('data-tour')
    );

    await page.getByRole('button', { name: /^(Next|Let's go)$/ }).click();
    await expect(tourTooltip(page)).toBeVisible();
  });

  /**
   * Every navigation step in the auction tour awaits an element with no `.catch`.
   * Before this change one slow load anywhere in the sequence killed the tour and
   * persisted it as completed, so the user never saw it again.
   */
  test('a failed navigation hook does not end the tour', async ({ page }) => {
    await page.route(/\/api\/trpc\/auction\./, (route) => route.abort());
    await page.goto('/auctions');
    await expect(tourTooltip(page)).toBeVisible();

    await page.getByRole('button', { name: /^(Next|Let's go)$/ }).click();
    await expect(tourTooltip(page)).toBeVisible({ timeout: 35_000 });
  });

  /**
   * The submit step is `hideFooter`, so clicking Generate was the only way forward —
   * which is why the button used to be force-enabled during a tour, handing a user
   * with no Buzz an enabled control and a server-side rejection. Both halves matter:
   * the button stays disabled AND the tour still has a way on.
   */
  test('an unaffordable generation leaves the button disabled and the tour walkable', async ({
    page,
  }) => {
    await page.route(/\/api\/trpc\/orchestrator\.whatIfFromGraph(\?|$)/, async (route) => {
      await route.fulfill({ status: 500, json: { error: { message: 'insufficient funds' } } });
    });
    await page.goto('/generate');
    await expect(tourTooltip(page)).toBeVisible();

    const generate = page.locator(GEN_SUBMIT_TARGET);
    await expect(generate).toBeDisabled();
    await expect(tourTooltip(page).getByRole('button', { name: 'Next' })).toBeVisible();
  });

  /**
   * The welcome tour is reachable only from `?tour=welcome`, which nothing in this
   * repo emits — so it has never been exercised at all. It stays (decision
   * 2026-08-28); this is the coverage that makes keeping it meaningful.
   */
  test('the welcome tour triggers from its URL and steps forward', async ({ page }) => {
    await page.goto(`/models/${MODEL_ID}?tour=welcome`);

    const tooltip = tourTooltip(page);
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText('Welcome to Civitai!')).toBeVisible();

    // Its first step is a centred intro whose Next is relabelled.
    await tooltip.getByRole('button', { name: "Let's go!" }).click();

    // Step 2 spotlights the carousel's remix button and is `hideFooter`, so the
    // tooltip must still be up and the button clickable rather than the tour having
    // silently advanced past a target that never rendered.
    await expect(tooltip).toBeVisible();
    await expect(page.locator('[data-tour="model:remix"]')).toBeVisible();
  });

  test('the model page help button restarts the welcome tour, not the model-page one', async ({
    page,
  }) => {
    await page.goto(`/models/${MODEL_ID}?tour=welcome`);
    await expect(tourTooltip(page).getByText('Welcome to Civitai!')).toBeVisible();

    await tourTooltip(page).getByRole('button', { name: 'No thanks' }).click();
    await expect(tourTooltip(page)).toBeHidden();

    await page.locator('[data-tour="model:help"], button[aria-label*="tour" i]').first().click();
    await expect(tourTooltip(page).getByText('Welcome to Civitai!')).toBeVisible();
  });
});
