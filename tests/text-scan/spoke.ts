import { expect, type Page } from '@playwright/test';
import { e2eEnv } from './env';

/** Clicks and returns; the caller waits on the RatingReview row, which is absorbing. */
export async function resolveRatingReview(
  page: Page,
  args: { reviewId: number; entityType: string; appliedLevel: number; comment?: string }
) {
  await page.goto(
    `${e2eEnv().TEXT_SCAN_E2E_MODERATOR_URL}/ratings?type=${args.entityType}&status=Pending`
  );
  const form = page.locator('form', {
    has: page.locator(`input[name="reviewId"][value="${args.reviewId}"]`),
  });
  await expect(form).toBeVisible();
  if (args.comment) await form.locator('textarea[name="modComment"]').fill(args.comment);
  await form.locator(`button[name="appliedLevel"][value="${args.appliedLevel}"]`).click();
}
