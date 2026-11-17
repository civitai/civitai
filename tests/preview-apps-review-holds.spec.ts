import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { acceptTermsForThisDomain } from './preview-tos';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: app REVIEW HOLDS (#8721), run as `mod` on its own per-preview off-site submission.
 *
 * No `getByTestId`: production builds strip `data-testid`, and the preview is one.
 *
 * Off-site, not on-site: holds are scoped by app slug and every review surface reads them the
 * same way, and an off-site listing can be submitted from a preview without the review-repo push
 * an on-site bundle needs.
 *
 * WHAT A PREVIEW CANNOT DO: complete an approve. The publish floor needs an icon and cover, and the
 * go-live scan gate needs those images `Scanned`, which never happens here (the scanner is
 * unreachable from previews). So the successful override (hold stamped `overridden` plus its
 * ModActivity row) is not exercised here; it is read back on prod from the first real override.
 *
 * WHY THE ROLLED-BACK OVERRIDE STILL PROVES SOMETHING: in `approveExternalRequest`
 * (offsite-listing.service.ts) `checkHoldsBeforeApprove` runs before `assertListingMeetsFloor` and
 * `assertAssetsScanClean`, and `resolveHoldsAtApprove` (the override stamp) runs inside the final
 * transaction after them. So with an open hold:
 *   - no override → 412 PRECONDITION_FAILED naming the hold (the hold gate refused);
 *   - an override listing every shown hold → 400 naming the missing icon/cover (the hold gate let it
 *     through and the floor refused), and the hold is still open (nothing was stamped);
 *   - an override missing a hold → 412 again.
 *
 * SAFE ON THE SHARED DEV DB: per-preview slug; nothing is approved (every approve here stops at a
 * gate, and any approve the page sends is aborted at the network layer). The hold is cleared and
 * the submission withdrawn in `finally`. A hold outlives a withdraw by design, so leftover open
 * holds on this slug are cleared before and after each run.
 */

const ROLE = 'mod' as const;
const PREVIEW_URL = process.env.PREVIEW_URL ?? '';
const HOLD_LABEL = 'CI preview: review holds';
const HOLD_REASON = 'ci-smoke review-holds check; cleared in this run';
const CLEAR_REASON = 'ci-smoke review-holds check done; clearing';
const OVERRIDE_REASON = 'ci-smoke override; expected to stop at the floor';

function previewSlug(suffix: string): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-hold-${suffix}-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

type Hold = {
  id: number;
  slug: string;
  placedByLabel: string;
  placedByUsername: string | null;
  reason: string;
  clearedAt: string | null;
  clearedKind: string | null;
};

const csrf = () => ({ origin: PREVIEW_URL, referer: `${PREVIEW_URL}/` });

async function listHolds(request: APIRequestContext, slug: string): Promise<Hold[]> {
  return trpcQuery<Hold[]>(request, 'blocks.listPublishRequestHolds', {
    slugs: [slug],
    includeCleared: true,
  });
}

async function clearOpenHolds(request: APIRequestContext, slug: string) {
  const holds = await listHolds(request, slug).catch(() => [] as Hold[]);
  for (const h of holds.filter((x) => !x.clearedAt)) {
    await trpcMutation(request, 'blocks.clearPublishRequestHold', {
      holdId: h.id,
      reason: CLEAR_REASON,
    }).catch(() => undefined);
  }
}

/** Status code and body of a mutation that is expected to fail. */
async function failingMutation(request: APIRequestContext, proc: string, input: unknown) {
  const res = await request.post(`/api/trpc/${proc}?batch=1`, {
    headers: { 'content-type': 'application/json', ...csrf() },
    data: { '0': { json: input } },
  });
  return { status: res.status(), text: JSON.stringify(await res.json().catch(() => ({}))) };
}

async function abortApprovals(page: Page) {
  await page.route('**/api/trpc/**', async (route) => {
    const url = route.request().url();
    if (url.includes('approveExternalRequest') || url.includes('blocks.approveRequest'))
      return route.abort();
    return route.continue();
  });
}

async function withdrawOffsite(request: APIRequestContext, slug: string) {
  let cursor: string | null = null;
  for (let page = 0; page < 25; page++) {
    const input: { limit: number; cursor?: string } = { limit: 100 };
    if (cursor) input.cursor = cursor;
    const list = await trpcQuery<{
      items: { id: string; slug: string }[];
      nextCursor: string | null;
    }>(request, 'appListings.listPendingRequests', input).catch(() => ({
      items: [],
      nextCursor: null,
    }));
    const hit = list.items.find((i) => i.slug === slug);
    if (hit) {
      await trpcMutation(request, 'appListings.withdrawExternalRequest', {
        publishRequestId: hit.id,
      }).catch(() => undefined);
      return;
    }
    if (!list.nextCursor) return;
    cursor = list.nextCursor;
  }
}

test.describe('App review holds (mod, nothing approved)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  // The pipeline log is the only artifact this tier returns, so a failure prints where the page was.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 1500));
      console.log(`[review-holds diag] test: ${testInfo.title}`);
      console.log(`[review-holds diag] url: ${page.url()}`);
      console.log(`[review-holds diag] error: ${testInfo.error?.message?.slice(0, 1500)}`);
      console.log(`[review-holds diag] body text:\n${text}`);
    } catch (err) {
      console.log(`[review-holds diag] could not read the page: ${String(err)}`);
    }
  });

  test('a hold shows in the queue and review modal, refuses approve, and clears', async ({
    page,
  }) => {
    const SLUG = previewSlug('off');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await acceptTermsForThisDomain(page);
    const request = page.request;
    await withdrawOffsite(request, SLUG);
    await clearOpenHolds(request, SLUG);
    await abortApprovals(page);
    let clientId: string | null = null;
    try {
      clientId = (
        await trpcMutation<{ clientId: string }>(request, 'oauthClient.create', {
          name: 'CI Smoke — review holds connect client',
          redirectUris: ['https://example.com/ci-smoke-oauth-callback'],
        })
      ).clientId;
      const { publishRequestId } = await trpcMutation<{ publishRequestId: string }>(
        request,
        'appListings.submitExternalListing',
        {
          slug: SLUG,
          name: 'CI Smoke — review holds',
          externalUrl: 'https://example.com/ci-smoke-review-holds',
          tagline: 'a pure external-link app',
          category: 'utility',
          contentRating: 'g',
          changelog: 'ci-smoke review holds',
          connectClientId: clientId,
          requestedScopes: 0,
          scopeJustifications: {},
        }
      );
      const hold = await trpcMutation<Hold>(request, 'blocks.placePublishRequestHold', {
        publishRequestId,
        kind: 'listing',
        label: HOLD_LABEL,
        reason: HOLD_REASON,
      });
      expect(hold.clearedAt, 'a new hold is open').toBeNull();

      // Queue: the app's row carries the badge.
      // The queue renders after its queries settle, and a fresh row can trail the write, so page
      // through it (Load more) and reload until the row appears.
      await page.goto('/apps/review', { waitUntil: 'domcontentloaded' });
      const row = page.getByRole('row').filter({ hasText: SLUG });
      await expect
        .poll(
          async () => {
            if (await row.count()) return true;
            const more = page.getByRole('button', { name: 'Load more' });
            if (await more.count()) await more.first().click();
            else await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);
            return (await row.count()) > 0;
          },
          { message: 'the held app is in the queue', timeout: 60_000 }
        )
        .toBe(true);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('On hold · 1');

      // Review modal: the panel names the hold, and the override field is offered.
      await row.getByRole('button', { name: 'Review', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: SLUG });
      await expect(dialog.getByText('1 open review hold', { exact: true })).toBeVisible();
      await expect(dialog.getByText(HOLD_LABEL).first()).toBeVisible();
      await expect(dialog.getByText(HOLD_REASON).first()).toBeVisible();
      await expect(
        dialog.getByLabel(/Override reason \(required to approve while holds are open\)/)
      ).toBeVisible();

      // No override: the hold gate refuses.
      const plain = await failingMutation(request, 'appListings.approveExternalRequest', {
        publishRequestId,
      });
      expect(plain.status, plain.text).toBe(412);
      expect(plain.text).toContain('PRECONDITION_FAILED');
      expect(plain.text).toContain(HOLD_LABEL);

      // An override that omits the open hold: still refused.
      const unseen = await failingMutation(request, 'appListings.approveExternalRequest', {
        publishRequestId,
        holdOverrideReason: OVERRIDE_REASON,
        holdOverrideIds: [],
      });
      expect(unseen.status, unseen.text).toBe(412);

      // An override naming the hold: the hold gate lets it through and the floor refuses.
      const overridden = await failingMutation(request, 'appListings.approveExternalRequest', {
        publishRequestId,
        holdOverrideReason: OVERRIDE_REASON,
        holdOverrideIds: [hold.id],
      });
      expect(overridden.status, overridden.text).toBe(400);
      expect(overridden.text).toMatch(/icon/i);
      expect(overridden.text).toMatch(/cover/i);

      // Rolled back: the hold is still open and was not stamped.
      const mid = (await listHolds(request, SLUG)).find((h) => h.id === hold.id);
      expect(mid?.clearedAt, 'a refused approve leaves the hold open').toBeNull();
      expect(mid?.clearedKind).toBeNull();

      // Clear with a reason, then read it back.
      await trpcMutation(request, 'blocks.clearPublishRequestHold', {
        holdId: hold.id,
        reason: CLEAR_REASON,
      });
      const after = (await listHolds(request, SLUG)).find((h) => h.id === hold.id);
      expect(after?.clearedKind, 'the hold reads back as cleared').toBe('cleared');
      expect(after?.clearedAt).not.toBeNull();
    } finally {
      await clearOpenHolds(request, SLUG);
      await withdrawOffsite(request, SLUG);
      if (clientId) {
        await trpcMutation(request, 'oauthClient.delete', { id: clientId }).catch(() => undefined);
      }
    }
  });
});
