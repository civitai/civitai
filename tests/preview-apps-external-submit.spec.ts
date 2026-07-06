import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: App Blocks W13 P3a — OFF-SITE (external-link) submission backend.
 *
 * The dark author-submit → mod-review-queue leg (design B1):
 *   - as the `tester` role (the app-dev-testers cohort — a NON-mod author),
 *     `appListings.submitExternalListing` creates a DRAFT AppListing + a pending
 *     AppListingPublishRequest (kind='offsite') for an https target.
 *   - as the `mod` role, `appListings.listPendingRequests` shows the row.
 *   - as the `tester`, `appListings.withdrawExternalRequest` is terminal — the
 *     draft listing is deleted and the row leaves the pending queue.
 *
 * approve/reject + the store render + the Visit-anchor invariant land in PR-b/PR-c
 * (with the approve service + UI), so they are NOT exercised here — this PR ships
 * the submission backend only.
 *
 * GATES the preview must satisfy for this to pass (Tekton `pr-smoke-test` is the
 * authoritative gate — do NOT run browser-mode Playwright locally on NixOS):
 *   - `submitExternalListing`/`withdrawExternalRequest` are `appDeveloperProcedure`
 *     (`app-blocks-author`); the `tester` fixture must be in that flag's cohort
 *     (mirrors the flipt-state `testers` allowlist — preview-fixtures.ts).
 *   - `listPendingRequests` is `moderatorProcedure`; the `mod` fixture passes.
 *
 * SAFE + SELF-CLEANING (the dev DB is shared across concurrent previews):
 *   - The slug is per-preview (`ci-smoke-ext-<host-label>`), so two previews never
 *     collide on `AppListing.slug @unique`. A same-preview re-run pre-withdraws any
 *     leftover pending row before submitting.
 *   - No asset upload / approve → NO Image rows, NO Tekton build, NO CF DNS.
 *   - We withdraw in `finally` (deletes the draft listing + releases the slug) so a
 *     mid-test failure leaves no draft/pending row and re-runs don't collide.
 */

const AUTHOR_ROLE = 'tester' as const;
const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

// Per-preview slug so concurrent previews don't collide on AppListing.slug @unique.
function previewSlug(): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* fall through to default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-smoke-ext-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

const SLUG = previewSlug();
const EXTERNAL_URL = 'https://example.com/ci-smoke-external-app';

type SubmitResult = { listingId: string; publishRequestId: string; slug: string };
type PendingItem = {
  id: string;
  slug: string;
  appListingId: string | null;
  appListing: { externalUrl: string | null } | null;
};
type PendingList = { items: PendingItem[]; nextCursor: string | null };

const submitInput = {
  slug: SLUG,
  name: 'CI Smoke — external app (P3a)',
  externalUrl: EXTERNAL_URL,
  tagline: 'a pure external-link app',
  category: 'utility',
  contentRating: 'g',
  changelog: 'ci-smoke submit',
};

/** Page the oldest-first pending queue to find our row by slug (it's the newest). */
async function findPendingBySlug(
  request: APIRequestContext,
  slug: string
): Promise<PendingItem | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 25; page++) {
    const input: { limit: number; cursor?: string } = { limit: 100 };
    if (cursor) input.cursor = cursor;
    const list = await trpcQuery<PendingList>(request, 'appListings.listPendingRequests', input);
    const hit = list.items.find((i) => i.slug === slug);
    if (hit) return hit;
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return null;
}

/** Best-effort: withdraw any leftover pending row for this slug (self-clean). */
async function withdrawPendingForSlug(
  authorRequest: APIRequestContext,
  modRequest: APIRequestContext,
  slug: string
): Promise<void> {
  const row = await findPendingBySlug(modRequest, slug).catch(() => null);
  if (row?.id) {
    await trpcMutation(authorRequest, 'appListings.withdrawExternalRequest', {
      publishRequestId: row.id,
    }).catch(() => {});
  }
}

test.describe('App Blocks P3a: off-site submit → mod queue → withdraw (tester+mod, self-cleaning)', () => {
  test.use({ storageState: storageStatePath(AUTHOR_ROLE) });

  test('tester submits an external listing → appears in the mod pending queue → withdraw removes it', async ({
    page,
    playwright,
    baseURL,
  }) => {
    // Warm page.request against the preview origin (carries the tester auth cookie;
    // the trpc helpers stamp Origin/Referer for the CSRF gate).
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const authorRequest = page.request;

    // A second context authed as the moderator, to read the review queue.
    const modRequest = await playwright.request.newContext({
      baseURL: baseURL ?? PREVIEW_URL,
      storageState: storageStatePath('mod'),
    });

    let publishRequestId: string | null = null;
    try {
      // Pre-clean any leftover pending row for this preview's slug (prior crashed run).
      await withdrawPendingForSlug(authorRequest, modRequest, SLUG);

      // SUBMIT as the tester (author) — creates a draft AppListing + pending request.
      const result = await trpcMutation<SubmitResult>(
        authorRequest,
        'appListings.submitExternalListing',
        submitInput
      );
      publishRequestId = result.publishRequestId;
      expect(typeof result.publishRequestId, 'submit returns a publishRequestId').toBe('string');
      expect(result.slug, 'slug echoes the submission').toBe(SLUG);

      // The row shows up in the MOD pending queue (kind='offsite' rows only).
      const item = await findPendingBySlug(modRequest, SLUG);
      expect(item, 'the submitted request appears in the mod pending queue').not.toBeNull();
      expect(item!.id, 'queue row id matches the submit result').toBe(publishRequestId);
      expect(
        item!.appListing?.externalUrl,
        'the draft listing carries the submitted https URL'
      ).toBe(EXTERNAL_URL);

      // WITHDRAW as the tester — terminal; deletes the draft listing + releases the slug.
      await trpcMutation(authorRequest, 'appListings.withdrawExternalRequest', {
        publishRequestId,
      });
      publishRequestId = null; // withdrawn — nothing left to clean in finally

      // Gone from the pending queue.
      const afterWithdraw = await findPendingBySlug(modRequest, SLUG);
      expect(afterWithdraw, 'the withdrawn request no longer appears in the queue').toBeNull();
    } finally {
      // SELF-CLEAN: withdraw so no draft/pending row lingers and re-runs don't collide.
      if (publishRequestId) {
        await trpcMutation(authorRequest, 'appListings.withdrawExternalRequest', {
          publishRequestId,
        }).catch(() => {});
      } else {
        await withdrawPendingForSlug(authorRequest, modRequest, SLUG);
      }
      await modRequest.dispose();
    }
  });
});
