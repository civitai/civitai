import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import JSZip from 'jszip';
import { previewAppBlockManifest } from './preview-app-block-manifest';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: app REVIEW HOLDS (#8721), run as `mod` on its own per-preview submissions.
 *
 * No `getByTestId`: production builds strip `data-testid`, and the preview is one.
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
 * SAFE ON THE SHARED DEV DB: per-preview slugs; nothing is approved (every approve here stops at a
 * gate, and the page's `blocks.approveRequest` is aborted at the network layer). Each hold is
 * cleared and each submission withdrawn in `finally`. A hold outlives a withdraw by design, so
 * leftover open holds on these slugs are cleared before and after each run.
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

async function placeHold(
  request: APIRequestContext,
  publishRequestId: string,
  kind: 'onsite' | 'listing'
): Promise<Hold> {
  return trpcMutation<Hold>(request, 'blocks.placePublishRequestHold', {
    publishRequestId,
    kind,
    label: HOLD_LABEL,
    reason: HOLD_REASON,
  });
}

/** Status code and body of a mutation that is expected to fail. */
async function failingMutation(request: APIRequestContext, proc: string, input: unknown) {
  const res = await request.post(`/api/trpc/${proc}?batch=1`, {
    headers: { 'content-type': 'application/json', ...csrf() },
    data: { '0': { json: input } },
  });
  return { status: res.status(), text: JSON.stringify(await res.json().catch(() => ({}))) };
}

// ── on-site fixture (same shape as preview-apps-review-flow.spec.ts) ──────────────────────────

async function bundle(slug: string): Promise<string> {
  const manifest = previewAppBlockManifest({ slug, name: `CI review holds ${slug.slice(-6)}` });
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('index.html', '<!doctype html><html><body><p>ci review holds</p></body></html>');
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

async function submitOnsite(request: APIRequestContext, slug: string): Promise<string> {
  const res = await request.post('/api/blocks/submit-version', {
    headers: { 'content-type': 'application/json', ...csrf() },
    data: { bundleBase64: await bundle(slug) },
  });
  const body = (await res.json().catch(() => ({}))) as { publishRequestId?: string };
  if (!res.ok() || !body.publishRequestId) {
    throw new Error(
      `submit-version ${slug} -> HTTP ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`
    );
  }
  return body.publishRequestId;
}

async function withdrawOnsite(request: APIRequestContext, slug: string) {
  const r = await trpcQuery<{ pending: { id: string } | null }>(
    request,
    'blocks.getMyPendingForSlug',
    {
      slug,
    }
  ).catch(() => ({ pending: null }));
  if (r?.pending?.id) {
    await trpcMutation(request, 'blocks.withdrawPublishRequest', {
      publishRequestId: r.pending.id,
    }).catch(() => undefined);
  }
}

async function abortApprovals(page: Page) {
  await page.route('**/api/trpc/**', async (route) => {
    if (route.request().url().includes('blocks.approveRequest')) return route.abort();
    return route.continue();
  });
}

/** Same as preview-apps-review-flow.spec.ts: the review page needs this domain's ToS accepted. */
async function acceptTermsForThisDomain(page: Page) {
  const meta = await page.evaluate(() => {
    const d = (window as unknown as { __NEXT_DATA__?: { props?: Record<string, unknown> } })
      .__NEXT_DATA__;
    const props = d?.props ?? {};
    return (props.tosMeta ?? (props.pageProps as Record<string, unknown> | undefined)?.tosMeta) as
      | { hash?: string; fieldKey?: string; hashFieldKey?: string }
      | undefined;
  });
  if (!meta?.hash || !meta.fieldKey || !meta.hashFieldKey) {
    throw new Error(`could not read the served ToS metadata: ${JSON.stringify(meta)}`);
  }
  const res = await page.request.post('/api/trpc/user.setSettings?batch=1', {
    headers: { 'content-type': 'application/json', ...csrf() },
    data: {
      '0': {
        json: { [meta.fieldKey]: new Date().toISOString(), [meta.hashFieldKey]: meta.hash },
        meta: { values: { [meta.fieldKey]: ['Date'] } },
      },
    },
  });
  if (!res.ok()) throw new Error(`user.setSettings (ToS acceptance) -> HTTP ${res.status()}`);
}

// ── off-site fixture (same shape as preview-apps-external-approve.spec.ts) ─────────────────────

async function submitOffsite(request: APIRequestContext, slug: string, connectClientId: string) {
  return trpcMutation<{ publishRequestId: string }>(request, 'appListings.submitExternalListing', {
    slug,
    name: 'CI Smoke — review holds',
    externalUrl: 'https://example.com/ci-smoke-review-holds',
    tagline: 'a pure external-link app',
    category: 'utility',
    contentRating: 'g',
    changelog: 'ci-smoke review holds',
    connectClientId,
    requestedScopes: 0,
    scopeJustifications: {},
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

  test('on-site: a hold shows in the queue and on the review page, then clears', async ({
    page,
  }) => {
    const SLUG = previewSlug('on');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await acceptTermsForThisDomain(page);
    const request = page.request;
    await withdrawOnsite(request, SLUG);
    await clearOpenHolds(request, SLUG);
    await abortApprovals(page);
    try {
      const requestId = await submitOnsite(request, SLUG);
      const hold = await placeHold(request, requestId, 'onsite');
      expect(hold.clearedAt, 'a new hold is open').toBeNull();

      // Queue: the app's row carries the badge.
      await page.goto('/apps/review', { waitUntil: 'domcontentloaded' });
      const row = page.getByRole('row').filter({ hasText: SLUG });
      for (let i = 0; i < 20 && !(await row.count()); i++) {
        const more = page.getByRole('button', { name: 'Load more' });
        if (!(await more.count())) break;
        await more.first().click();
        await page.waitForTimeout(1000);
      }
      await expect(row, 'the held app is in the queue').toHaveCount(1);
      await expect(row).toContainText('On hold · 1');

      // Review page: the panel names the hold, and the override field is offered.
      await page.goto(`/apps/review/${requestId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('1 open review hold', { exact: true })).toBeVisible();
      await expect(page.getByText(HOLD_LABEL).first()).toBeVisible();
      await expect(page.getByText(HOLD_REASON).first()).toBeVisible();
      await expect(
        page.getByLabel(/Override reason \(required to approve while holds are open\)/)
      ).toBeVisible();

      // Clear with a reason, then read it back.
      await trpcMutation(request, 'blocks.clearPublishRequestHold', {
        holdId: hold.id,
        reason: CLEAR_REASON,
      });
      const after = (await listHolds(request, SLUG)).find((h) => h.id === hold.id);
      expect(after?.clearedKind, 'the hold reads back as cleared').toBe('cleared');
      expect(after?.clearedAt).not.toBeNull();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText('1 open review hold', { exact: true })).toHaveCount(0);
    } finally {
      await clearOpenHolds(request, SLUG);
      await withdrawOnsite(request, SLUG);
    }
  });

  test('off-site: approve refuses while held; an override passes the hold gate and stops at the floor', async ({
    page,
  }) => {
    const SLUG = previewSlug('off');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;
    await withdrawOffsite(request, SLUG);
    await clearOpenHolds(request, SLUG);
    let clientId: string | null = null;
    try {
      clientId = (
        await trpcMutation<{ clientId: string }>(request, 'oauthClient.create', {
          name: 'CI Smoke — review holds connect client',
          redirectUris: ['https://example.com/ci-smoke-oauth-callback'],
        })
      ).clientId;
      const { publishRequestId } = await submitOffsite(request, SLUG, clientId);
      const hold = await placeHold(request, publishRequestId, 'listing');

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

      await trpcMutation(request, 'blocks.clearPublishRequestHold', {
        holdId: hold.id,
        reason: CLEAR_REASON,
      });
      const after = (await listHolds(request, SLUG)).find((h) => h.id === hold.id);
      expect(after?.clearedKind).toBe('cleared');
    } finally {
      await clearOpenHolds(request, SLUG);
      await withdrawOffsite(request, SLUG);
      if (clientId) {
        await trpcMutation(request, 'oauthClient.delete', { id: clientId }).catch(() => undefined);
      }
    }
  });
});
