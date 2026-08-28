import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authDegen } from './auth/data';
import { GEN_SUBMIT_TARGET } from '~/components/Tours/tour-targets';

/**
 * Re-firing a tour means defeating BOTH persistence stores: completion lives in
 * localStorage `tours` AND in `User.settings.tourSettings`, with the server winning.
 * Route-mocking `getSettings` only fakes the read, so a previous run's completion
 * can't carry forward — it does nothing about the write: `user.setSettings` still
 * persists `completed`/`reason` to the shared `authDegen` account on every run.
 */
const forceFirstRun = async (page: Page) => {
  await page.addInitScript(() => window.localStorage.removeItem('tours'));
  await page.route(/\/api\/trpc\/user\.getSettings(\?|$)/, async (route) => {
    await route.fulfill({ json: { result: { data: { json: { tourSettings: {} } } } } });
  });
};

const tourTooltip = (page: Page) => page.getByRole('alertdialog');

// The welcome tour's steps 2-3 depend on the carousel's remix button (and the menu it
// opens), which only renders for an image the generator can remix. A model without one
// silently reduces the tour to its intro step.
const MODEL_ID = process.env.E2E_TOUR_MODEL_ID ?? '1';

test.describe('guided tours', () => {
  test.use(authDegen);

  test.beforeEach(async ({ page }) => {
    await forceFirstRun(page);
  });

  test('the generator tour opens and advances past its intro step', async ({ page }) => {
    await page.goto('/generate');
    await expect(tourTooltip(page)).toBeVisible();

    await tourTooltip(page).getByRole('button', { name: "Let's go" }).click();
    await expect(tourTooltip(page)).toBeVisible();
  });

  // Needs a click path to a step whose target can be removed; the intervening
  // steps are `hideFooter`.
  test.fixme('a missing target does not end the tour', async ({ page }) => {
    await page.goto('/generate');
    await expect(tourTooltip(page)).toBeVisible();

    await page.evaluate(() =>
      document.querySelector('[data-tour="gen:prompt"]')?.removeAttribute('data-tour')
    );

    await page.getByRole('button', { name: /^(Next|Let's go)$/ }).click();
    await expect(tourTooltip(page)).toBeVisible();
  });

  // Needs to reach auction steps 1-5, where the unguarded `waitForElement` calls
  // live. One click only moves step0->step1, and both are centred with no
  // `onNext`, so as written it passes with or without the fix.
  test.fixme('a failed navigation hook does not end the tour', async ({ page }) => {
    await page.route(/\/api\/trpc\/auction\./, (route) => route.abort());
    await page.goto('/auctions');
    await expect(tourTooltip(page)).toBeVisible();

    await page.getByRole('button', { name: /^(Next|Let's go)$/ }).click();
    await expect(tourTooltip(page)).toBeVisible({ timeout: 35_000 });
  });

  // Needs to reach the `gen:submit` step (index 6). Both halves must be
  // asserted when it is written: the button disabled AND the tour still
  // walkable, since asserting only the first passes on a build where the
  // tour is stranded. Cover both ways `submitBlocked` disables the button —
  // this mocked insufficient-Buzz case, and a full generation queue
  // (`canGenerate: false`) — neither has unit coverage, since mounting
  // FormFooter's context graph for it is disproportionate.
  test.fixme('an unaffordable generation leaves the button disabled and the tour walkable', async ({
    page,
  }) => {
    await page.route(/\/api\/trpc\/orchestrator\.whatIfFromGraph(\?|$)/, async (route) => {
      await route.fulfill({
        status: 400,
        json: {
          error: {
            json: {
              message: 'insufficient funds',
              code: -32600,
              data: {
                code: 'BAD_REQUEST',
                httpStatus: 400,
                path: 'orchestrator.whatIfFromGraph',
              },
            },
          },
        },
      });
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
