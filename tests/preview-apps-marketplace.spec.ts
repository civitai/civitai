import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Preview-e2e (F-C): App Blocks MARKETPLACE discovery + per-app detail — the
 * anon-capable PUBLIC read path (`blocks.listAvailable` → `blocks.getAppDetail`)
 * plus the two host pages that render them (`/apps`, `/apps/<appBlockId>`).
 * Otherwise untested by the preview suite; a PR that broke the marketplace
 * listing/detail projection or the `features.appBlocks` page gate passes every
 * other preview spec today.
 *
 * Runs as the `mod` fixture (id 2000000001) — the ONLY preview role with
 * `features.appBlocks` (the Flipt `app-blocks-enabled` flag is moderator-segment
 * -only) AND exempt from the per-IP marketplace rate limit (listAvailable /
 * getAppDetail carry a 60/60 rateLimit that the middleware waives for mods).
 * The non-mod testers do NOT have appBlocks: for them /apps SSR-resolves to a
 * Next 404 (resolveAppsPageAccess → notFound) and listAvailable returns empty —
 * so this MUST run as mod to exercise the real read path.
 *
 * Data resilience: the dev DB is a weekly prod clone — there are ~3 approved app
 * blocks today, but a given clone could have zero. So we DISCOVER an appBlockId
 * at runtime from `listAvailable` (never hardcode one) and `test.skip()` with an
 * annotation when the clone has no approved blocks, rather than hard-failing.
 *
 * NB: these procs are DB-backed (not meili-backed search), so no `retryFlaky`.
 *
 * Verified tRPC shapes (against origin/main, paths relative to civitai/src):
 *  - blocks.listAvailable (blocks.router.ts:952 publicProcedure + enforceApp
 *    BlocksFlag + 60/60 rateLimit; input listAvailableSchema, all fields
 *    optional/defaulted so `{}` is valid) RETURNS AN OBJECT, NOT a bare array:
 *    `{ items: AvailableBlock[]; nextCursor?: string }`
 *    (BlockRegistry.listAvailable, block-registry.service.ts:2226). Each
 *    AvailableBlock (subscription.schema.ts:157) = { id, blockId, appId,
 *    appName, manifest: PublicBlockManifest, installCount, category,
 *    scopesSummary }. We DISCOVER an id from `items[0].id` (that id is the
 *    `appBlockId`).
 *  - blocks.getAppDetail (blocks.router.ts:1001 publicProcedure + flag +
 *    60/60 rateLimit; input { appBlockId }) returns `PublicAppDetail | null`
 *    (subscription.schema.ts:371): { id, blockId, appId, appName, manifest:
 *    { name?, description?, targets? }, scopes: string[], contentRating,
 *    version, installCount, liveUrl, screenshots }. Returns null for a missing
 *    / non-approved id (the router then throws NOT_FOUND — our helper would
 *    surface that as a thrown error). We assert the shape of a discovered,
 *    known-approved id, so a non-null detail is expected.
 *  - Detail page (`/apps/[appBlockId]/index.tsx`) renders the block name as
 *    `<Title order={2}>{name}</Title>` where
 *    `name = detail.manifest.name ?? detail.blockId ?? appBlockId` — so the
 *    visible host-rendered name == `manifest.name || blockId`.
 *  - Marketplace page (`/apps/index.tsx`) renders `<Title order={2}>Civitai App
 *    Blocks</Title>` for an appBlocks-enabled viewer; a non-appBlocks viewer
 *    gets the Next 404 (resolveAppsPageAccess.ts → notFound).
 */

const ROLE = 'mod' as const;

// Public marketplace listing shape (the fields this spec reads). Mirrors
// AvailableBlock — typed locally so the tRPC result isn't `unknown`/implicit any.
type AvailableBlock = {
  id: string;
  blockId: string;
  appId: string;
  appName: string | null;
  manifest: { name?: string; description?: string; targets?: Array<{ slotId?: string }> };
  installCount: number;
  category: string | null;
  scopesSummary: string[];
};
type ListAvailableResult = { items: AvailableBlock[]; nextCursor?: string };

// Public per-app detail shape (the fields this spec reads). Mirrors
// PublicAppDetail — getAppDetail returns this or null.
type PublicAppDetail = {
  id: string;
  blockId: string;
  appId: string;
  appName: string | null;
  manifest: { name?: string; description?: string; targets?: Array<{ slotId?: string }> };
  scopes: string[];
  contentRating: string | null;
  version: string | null;
  installCount: number;
  liveUrl: string;
  screenshots: Array<{ index: number; url: string; contentType: string }>;
};

test.describe('App Blocks marketplace discovery + detail render (mod)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('listAvailable → getAppDetail round-trip + /apps and /apps/[id] render', async ({
    page,
  }) => {
    // The marketplace index renders for an appBlocks-enabled viewer (the mod) and
    // 404s for everyone else. Asserting it loads (status < 400) + shows its known
    // heading proves the mod cleared the `features.appBlocks` SSR gate (NOT the
    // 404 a non-appBlocks user gets). domcontentloaded ONLY — never networkidle.
    const resp = await page.goto('/apps', { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'GET /apps status for the appBlocks-enabled mod').toBeLessThan(400);
    await expect(
      page.getByRole('heading', { name: 'Civitai App Blocks' }),
      '/apps should render the marketplace heading for an appBlocks-enabled mod (not a 404)'
    ).toBeVisible();

    // DISCOVER an appBlockId at runtime from the public listing. Never hardcode
    // one — the weekly dev clone's approved set varies. `{}` input is valid (all
    // listAvailableSchema fields are optional/defaulted). page.request carries the
    // mod cookie; the helper stamps Origin/Referer for the CSRF gate.
    const listing = await trpcQuery<ListAvailableResult>(page.request, 'blocks.listAvailable', {});
    expect(
      Array.isArray(listing?.items),
      'blocks.listAvailable should resolve to { items: AvailableBlock[] }'
    ).toBe(true);

    const blocks = listing?.items ?? [];
    test.skip(
      blocks.length === 0,
      'No approved app blocks in this dev-DB clone — nothing to discover (the weekly prod clone can have zero). Skipping the detail-render leg rather than hard-failing.'
    );

    // One representative block — don't crawl the whole list.
    const first = blocks[0];
    expect(typeof first.id, 'each listed block should carry a string id (the appBlockId)').toBe(
      'string'
    );

    // Per-app DETAIL for that exact block. getAppDetail returns the public
    // projection for an approved id; a discovered id IS approved (listAvailable
    // only returns status='approved' rows), so detail must be non-null.
    const detail = await trpcQuery<PublicAppDetail | null>(page.request, 'blocks.getAppDetail', {
      appBlockId: first.id,
    });
    expect(
      detail,
      'getAppDetail should return a non-null detail for a discovered approved id'
    ).not.toBeNull();
    expect(detail!.id, 'getAppDetail.id should echo the requested appBlockId').toBe(first.id);
    // A human display name: manifest.name is the public allowlist field; fall back
    // to blockId (the page does the same: name = manifest.name ?? blockId ?? id).
    const detailName = detail!.manifest.name ?? detail!.blockId;
    expect(
      typeof detailName,
      'detail should expose a display name (manifest.name or blockId)'
    ).toBe('string');
    expect(detailName.length, 'the display name should be non-empty').toBeGreaterThan(0);
    // The scopes + slots arrays are shape-correct (anon-display allowlist).
    expect(Array.isArray(detail!.scopes), 'detail.scopes should be an array').toBe(true);
    expect(
      Array.isArray(detail!.manifest.targets ?? []),
      'detail.manifest.targets should be an array (slot badges)'
    ).toBe(true);

    // The DETAIL PAGE renders that block's name (host-rendered <Title> text). This
    // proves the page's getAppDetail query + SSR appBlocks gate work end-to-end,
    // not just the bare tRPC call. domcontentloaded ONLY.
    const detailResp = await page.goto(`/apps/${encodeURIComponent(first.id)}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(detailResp?.status(), `GET /apps/${first.id} status`).toBeLessThan(400);
    await expect(
      page.getByRole('heading', { name: detailName }),
      `the detail page should render the block name "${detailName}"`
    ).toBeVisible();
  });
});
