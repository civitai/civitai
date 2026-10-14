import { expect, test } from '@playwright/test';

/**
 * Smoke path through the demo storyline built by scripts/storylines/storylines-demo-seed.sql:
 * image detail -> storyline mode -> end of the main path -> forks -> coming-soon prompt.
 *
 * Runs against a dev server on the dev database, not the local e2e database, so it signs in
 * itself and must be run without the `setup` project (which asserts a local database):
 *
 *   STORYLINE_SMOKE_BASE_URL=<the dev server, default http://localhost:3000>
 *   STORYLINE_SMOKE_TOKEN=<a civ-token session for a test account, never a real person's>
 *   STORYLINE_SMOKE_FIRST_IMAGE_ID=<firstImageId of the depth-0 chapter>
 *   STORYLINE_SMOKE_LAST_IMAGE_ID=<lastImageId of the depth-3 chapter>
 *   STORYLINE_SMOKE_LAST_CHAPTER_ID=<chapterId of the depth-3 chapter>
 *   pnpm exec playwright test tests/storylines-smoke.spec.ts --project chromium --no-deps
 *
 * The seed prints every id. Not covered: the pill on a feed card, because which images the feed
 * shows is not under the test's control; check that step by hand.
 */

const env = {
  token: process.env.STORYLINE_SMOKE_TOKEN,
  firstImageId: process.env.STORYLINE_SMOKE_FIRST_IMAGE_ID,
  lastImageId: process.env.STORYLINE_SMOKE_LAST_IMAGE_ID,
  lastChapterId: process.env.STORYLINE_SMOKE_LAST_CHAPTER_ID,
};

test.describe('storylines smoke', () => {
  test.skip(
    Object.values(env).some((v) => !v),
    'set the STORYLINE_SMOKE_* variables (see the header of this file)'
  );

  test.use({ baseURL: process.env.STORYLINE_SMOKE_BASE_URL ?? 'http://localhost:3000' });

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'civ-token', value: env.token as string, url: baseURL }]);
  });

  test('image detail enters storyline mode', async ({ page }) => {
    await page.goto(`/images/${env.firstImageId}`);
    await page.getByTestId('storyline-enter').click();

    await expect(page).toHaveURL(/[?&]storylineChapter=\d+/);
    await expect(page.getByTestId('storyline-banner')).toBeVisible();

    await page.getByTestId('storyline-pill').click();
    await expect(page.getByTestId('storyline-subway')).toBeVisible();
  });

  test('end of the main path offers the forks, then the coming-soon prompt', async ({ page }) => {
    await page.goto(`/images/${env.lastImageId}?storylineChapter=${env.lastChapterId}`);
    await expect(page.getByTestId('storyline-banner')).toBeVisible();

    await page.getByTestId('storyline-next').click();
    await expect(page.getByTestId('storyline-end-of-chapter')).toBeVisible();

    // The demo has three continuations; the one above the storyline's ceiling must not show.
    const forks = page.getByTestId('storyline-fork');
    await expect(forks).toHaveCount(2);
    await expect(forks.nth(0)).toHaveAttribute('data-rank', 'canon');
    await expect(forks.nth(1)).toHaveAttribute('data-rank', 'endorsed');

    await page.getByTestId('storyline-create-next').click();
    await expect(page.getByRole('dialog').getByText('Get early access')).toBeVisible();
  });
});
