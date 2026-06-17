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
 *    by `block_id`, and renders `<PageBlockHost>` (data-testid="app-page-frame"
 *    with the `<iframe data-testid="app-page-iframe">` inside, plus the W7
 *    `data-testid="app-block-chrome"` trust bar).
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

  test('a page-declaring app opens at /apps/run/<slug> and the iframe mounts + inits', async ({
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
    // proves PageBlockHost mounted (not a 404 / blank).
    await expect(
      page.getByTestId('app-block-chrome'),
      'the full-page host should render the W7 trust chrome'
    ).toBeVisible();

    // The block iframe mounts (server-resolved manifest.iframe.src).
    const frame = page.getByTestId('app-page-iframe');
    await expect(frame, 'the full-page block iframe should mount').toBeVisible();

    // The host posts BLOCK_INIT (viewer page token + subPath) on a retry loop
    // until the block acks BLOCK_READY → data-block-ready flips to "true". This
    // is the e2e proof that the page-mint + handshake worked. Allow generous
    // time for the cross-origin bundle to load + ack on a cold preview.
    await expect(
      frame,
      'the full-page block should receive BLOCK_INIT and ack ready (page token minted)'
    ).toHaveAttribute('data-block-ready', 'true', { timeout: 20_000 });
  });
});
