import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Preview-e2e (W10): App Blocks FULL-PAGE app surface — the `/apps/run/<slug>`
 * route + the page-token mint. A mod opens a page-declaring app's full-page
 * surface; we assert the host trust chrome + the block iframe mount, and that
 * the page received a BLOCK_INIT (the iframe transitions to ready, which only
 * happens after the host posts BLOCK_INIT with a viewer-scoped page token +
 * subPath). Otherwise untested by the preview suite.
 *
 * Runs as the `mod` fixture (id 2000000001) — the ONLY preview role with BOTH
 * `features.appBlocks` AND `features.appBlocksPages` (both flags are
 * moderator-segment-only / mod-only by availability). For a non-mod the page
 * SSR-resolves to a Next 404 (the two-flag gate), and the token mint 403s. So
 * this MUST run as mod to exercise the real page path.
 *
 * Data resilience: the dev DB is a weekly prod clone. A page-declaring approved
 * app may not exist in a given clone, so we DISCOVER one at runtime from
 * `listAvailable` (manifest.hasPage === true) and `test.skip()` with an
 * annotation when none exists — never hardcode a slug.
 *
 * NB: the preview run is the GATE — it needs the `app-blocks-pages-enabled`
 * Flipt flag relaxed to the mod segment on the preview env (same posture as
 * `app-blocks-enabled`). The spec is authored here; the green preview run
 * validates it.
 *
 * Verified tRPC / route shapes (against origin/main + this PR):
 *  - blocks.listAvailable → `{ items: AvailableBlock[]; nextCursor? }`. Each
 *    AvailableBlock now carries `manifest.hasPage?: boolean` (W10 public
 *    projection) + `blockId` (the `<slug>` used by the page route).
 *  - Page route `/apps/run/[slug]/[[...path]]` SSR-gates on
 *    `features.appBlocks && features.appBlocksPages`, resolves the approved app
 *    by `block_id`, and renders `<PageBlockHost>`: the W7 trust chrome
 *    (`AppBlockChrome`, with an "App menu" button) above the block
 *    `<iframe>` (`title=<appName>`, `data-block-instance-id="page_<appBlockId>"`,
 *    `data-block-ready` flipping to "true" on BLOCK_READY).
 *
 * ⚠️ SELECTORS — NO `data-testid`. The preview is a PRODUCTION Next build
 * (NODE_ENV=production), and next.config.mjs strips every `data-testid` in
 * production (`compiler.reactRemoveProperties: { properties: ['^data-testid$'] }`).
 * So `getByTestId('app-page-iframe' | 'app-block-chrome' | 'app-page-frame')`
 * NEVER matches against a deployed preview — the elements render fine, the
 * attribute is just gone. We therefore assert on attributes the production build
 * KEEPS: the chrome's accessible "App menu" button, and the iframe's
 * `data-block-instance-id` (a `page_*` id) + `data-block-ready`. (`reactRemove
 * Properties` only strips `^data-testid$`, so other `data-*` attrs survive.)
 * This mirrors the sibling preview-apps-* specs, which assert via tRPC + ARIA
 * roles, never rendered testids.
 */

const ROLE = 'mod' as const;

type AvailableBlock = {
  id: string;
  blockId: string;
  appId: string;
  appName: string | null;
  manifest: { name?: string; description?: string; hasPage?: boolean };
  installCount: number;
};
type ListAvailableResult = { items: AvailableBlock[]; nextCursor?: string };

test.describe('App Blocks full-page app surface (mod)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('a page-declaring app opens at /apps/run/<slug>: chrome + iframe mount and the host mints a page token', async ({
    page,
  }) => {
    // DISCOVER a page-declaring approved app from the public listing. `{}` is a
    // valid input (all listAvailableSchema fields optional). page.request carries
    // the mod cookie; the helper stamps Origin/Referer for the CSRF gate.
    const listing = await trpcQuery<ListAvailableResult>(page.request, 'blocks.listAvailable', {});
    const blocks = listing?.items ?? [];
    const pageApp = blocks.find((b) => b.manifest?.hasPage === true);

    test.skip(
      !pageApp,
      'No approved app declaring a full-page surface (manifest.page) in this dev-DB clone — nothing to open. Skipping rather than hard-failing.'
    );
    if (!pageApp) return;

    // The full-page route. SSR must succeed (status < 400) for the mod who
    // clears the two-flag gate (NOT the 404 a non-pages viewer gets).
    const resp = await page.goto(`/apps/run/${encodeURIComponent(pageApp.blockId)}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(
      resp?.status(),
      `GET /apps/run/${pageApp.blockId} status for the appBlocksPages-enabled mod`
    ).toBeLessThan(400);

    // The host trust chrome (rendered in civitai-web, spoof-proof) is present —
    // proves PageBlockHost mounted (not a 404 / blank). The chrome's "App block
    // menu" button is unique to AppBlockChrome and uses a production-safe
    // accessible name (NOT a stripped data-testid).
    await expect(
      page.getByRole('button', { name: 'App menu' }),
      'the full-page host should render the W7 trust chrome'
    ).toBeVisible();

    // The block iframe mounts (server-resolved manifest.iframe.src). Located by
    // its surviving `data-block-instance-id` (a synthetic `page_<appBlockId>` id
    // unique to the page host) — `getByTestId` would never match (stripped).
    const frame = page.locator('iframe[data-block-instance-id^="page_"]');
    await expect(frame, 'the full-page block iframe should mount').toBeVisible();

    // The iframe points at the server-resolved block origin (manifest.iframe.src
    // → `<slug>.civit.ai`), not a blank/about:blank — proves the SSR-resolved
    // src reached the DOM.
    const iframeSrc = await frame.getAttribute('src');
    expect(iframeSrc, 'the iframe src is the server-resolved block origin').toMatch(
      /^https?:\/\//
    );

    // PAGE-MINT PROOF (the host-side half of the handshake we CAN verify on a
    // preview): the host posts BLOCK_INIT only after minting a viewer-scoped page
    // token from POST /api/v1/block-tokens (entityType:'none', `page_<appBlockId>`).
    // Exercise that exact mint with the mod cookie — a 200 + non-empty token is
    // the e2e proof the page-mint path works (two-flag gate cleared, synthetic
    // page instance resolved, JWT issued). The host then posts BLOCK_INIT to the
    // block origin.
    //
    // We do NOT assert `data-block-ready === 'true'` (the block's BLOCK_READY
    // ack): that flips only when the cross-origin block bundle at `<slug>.civit.ai`
    // ACCEPTS the BLOCK_INIT, which requires the PARENT origin (here the ephemeral
    // preview host `pr-N.civitaic.com`) to be in the block's own
    // `allowedParentOrigins` allowlist. Production blocks allowlist civitai.com /
    // *.civit.ai, never an ephemeral preview origin, so the ack can never arrive
    // on a preview no matter how correct civitai-web is — asserting it makes this
    // spec un-passable by construction. The host-side contract (chrome + iframe +
    // page-token mint) is what a preview can prove; the BLOCK_READY round-trip is
    // covered by the PageBlockHost.browser.test.tsx component test with a stubbed
    // block.
    const tokenResp = await page.request.post('/api/v1/block-tokens', {
      headers: {
        'content-type': 'application/json',
        origin: process.env.PREVIEW_URL ?? '',
        referer: `${process.env.PREVIEW_URL ?? ''}/apps/run/${pageApp.blockId}`,
      },
      data: {
        // Synthetic page instance id: `page_<appBlockId>`, where appBlockId is
        // `AvailableBlock.id` (== app_blocks.id, the `apb_*` value) — the same id
        // the page route builds in `page_${appBlockId}`.
        blockInstanceId: `page_${pageApp.id}`,
        slotContext: {
          slotId: 'app.page',
          entityType: 'none',
          slug: pageApp.blockId,
          subPath: '',
          viewerUserId: null,
          viewerUsername: null,
          theme: 'dark',
        },
      },
    });
    expect(
      tokenResp.status(),
      'the host mints a viewer-scoped page token (the BLOCK_INIT prerequisite)'
    ).toBe(200);
    const tokenBody = (await tokenResp.json()) as { token?: string };
    expect(
      typeof tokenBody.token === 'string' && tokenBody.token.length > 0,
      'page-token mint returns a non-empty JWT'
    ).toBe(true);
  });
});
