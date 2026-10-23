import { expect as baseExpect, test } from '@playwright/test';

// A dev server compiles routes on demand and loads real data: the default 5s is too short.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * Smoke path through the demo storyline built by scripts/storylines/storylines-demo-seed.sql.
 *
 * Runs against a dev server on the dev database, not the local e2e database, so it signs in
 * itself and must be run without the `setup` project (which asserts a local database). It is
 * collected only when STORYLINE_SMOKE_TOKEN is set (see playwright.config.ts):
 *
 *   STORYLINE_SMOKE_BASE_URL=<the dev server, default http://localhost:3000>
 *   STORYLINE_SMOKE_TOKEN=<a civ-token session for a test account, never a real person's>
 *   STORYLINE_SMOKE_FIRST_IMAGE_ID=<firstImageId of the depth-0 chapter>
 *   STORYLINE_SMOKE_LAST_IMAGE_ID=<lastImageId of the depth-3 chapter>
 *   STORYLINE_SMOKE_LAST_CHAPTER_ID=<chapterId of the depth-3 chapter>
 *   STORYLINE_SMOKE_ABOVE_CEILING_CHAPTER_ID=<chapterId of the row with aboveCeiling = true>
 *   pnpm exec playwright test tests/storylines-smoke.spec.ts --project chromium --no-deps
 *
 * The seed prints every id. Seed it without a community account: the fork count below assumes
 * the default three continuations. The account's browsing level must include PG-13, or the
 * readable continuations turn into placeholders too.
 *
 * Not covered: the pill on a feed card, because which images the feed shows is not under the
 * test's control; check that step by hand.
 */

const env = {
  token: process.env.STORYLINE_SMOKE_TOKEN,
  firstImageId: process.env.STORYLINE_SMOKE_FIRST_IMAGE_ID,
  lastImageId: process.env.STORYLINE_SMOKE_LAST_IMAGE_ID,
  lastChapterId: process.env.STORYLINE_SMOKE_LAST_CHAPTER_ID,
  aboveCeilingChapterId: process.env.STORYLINE_SMOKE_ABOVE_CEILING_CHAPTER_ID,
};

const missing = Object.entries(env)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  throw new Error(`storylines-smoke: missing env for ${missing.join(', ')} (see the file header)`);
}

test.describe('storylines smoke', () => {
  test.use({ baseURL: process.env.STORYLINE_SMOKE_BASE_URL ?? 'http://localhost:3000' });

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'civ-token', value: env.token as string, url: baseURL }]);
  });

  test('image detail enters storyline mode', async ({ page }) => {
    await page.goto(`/images/${env.firstImageId}`);
    await page.getByTestId('storyline-enter').click();

    await expect(page).toHaveURL(/[?&]storylineChapter=\d+/);
    await expect(page.getByTestId('storyline-mode-chip')).toContainText('The Patch');

    await page.getByTestId('storyline-mode-chip').click();
    await expect(page.getByTestId('storyline-subway')).toBeVisible();
  });

  test('end of the main path offers the forks, then the coming-soon prompt', async ({ page }) => {
    await page.goto(`/images/${env.lastImageId}?storylineChapter=${env.lastChapterId}`);
    await expect(page.getByTestId('storyline-mode-chip')).toBeVisible();

    await page.getByTestId('storyline-next').click();
    await expect(page.getByTestId('storyline-end-of-chapter')).toBeVisible();

    // The toolbar chip stays clickable with the end card open: a click only lands if nothing
    // covers it. Esc then closes the sheet, which holds focus once open.
    await page.getByTestId('storyline-mode-chip').click();
    await expect(page.getByTestId('storyline-subway')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('storyline-subway')).toBeHidden();

    const forks = page.getByTestId('storyline-fork');
    await expect(forks).toHaveCount(3);

    const aboveCeiling = page.locator(
      `[data-testid="storyline-fork"][data-chapter-id="${env.aboveCeilingChapterId}"]`
    );
    await expect(aboveCeiling).toHaveAttribute('data-tombstone', 'aboveStoryRating');
    await expect(aboveCeiling).toContainText("This chapter is rated above the storyline's maximum");
    await expect(aboveCeiling).not.toContainText(' by ');

    const readable = page.locator('[data-testid="storyline-fork"]:not([data-tombstone])');
    await expect(readable).toHaveCount(2);
    await expect(readable.nth(0)).toHaveAttribute('data-rank', 'canon');
    await expect(readable.nth(1)).toHaveAttribute('data-rank', 'endorsed');
    // The author credit the placeholder must not show ("Chapter 5 by CivChan"); proves the
    // pattern above can match.
    await expect(readable.nth(1)).toContainText(' by ');
    // Read again once settled: toHaveCount passes at the first moment it matches.
    expect(await forks.count()).toBe(3);

    await page.getByTestId('storyline-create-next').click();
    // Title and badge render whether or not the account is signed in or already on the list.
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('Create the next section')).toBeVisible();
    await expect(prompt.getByText('Coming soon')).toBeVisible();
  });
});
