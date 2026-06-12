import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Feed-content smoke: the core BROWSE path actually renders real content.
 *
 * preview-smoke.spec.ts only proves /models and /images LOAD (HTTP <400, not
 * bounced to /login or /preview-restricted) — it never asserts the feed returns
 * any items. An empty-feed or broken-list regression (a busted model.getAll
 * handler, a query that 500s, a filter that nukes every row) passes every preview
 * spec today while shipping a blank site. This closes that gap for the DB-backed
 * models feed by asserting its backing query returns a non-empty, structurally
 * valid page of content.
 *
 * Why tRPC instead of scraping cards out of the DOM:
 *  - The /models feed IS this query — model.getAll backs it
 *    (src/components/Model/model.utils.ts:145 `trpc.model.getAll.useInfiniteQuery`).
 *    Asserting the query result is asserting the same data the card grid renders,
 *    minus the flaky virtualized-list / lazy-image DOM surface (cards mount on
 *    scroll/intersection, have no stable testid) — a DOM-card count would be the
 *    brittle proxy here, not the source of truth.
 *  - Self-contained against the preview's OWN dev-clone DB: no external service,
 *    no scroll timing, no networkidle (which never settles — see gotchas below).
 *
 * Runs as `tester` (a free member that PASSES the preview gate). model.getAll is a
 * publicProcedure, reachable for a gate-passing user. page.request carries the
 * test's storageState auth cookie, and preview-auth.middleware gates /api/trpc/*
 * (only /api/auth, /login, /preview-restricted, /_next, /favicon are exempt —
 * matcher '/:path*'), so the authed cookie is what lets the call through the gate —
 * same authed-tRPC pattern as preview-engagement.spec.ts.
 *
 * Verified tRPC shape (civitai repo, paths relative to civitai/src):
 *  - model.getAll  publicProcedure, input getAllModelsSchema (minus `page`)
 *                  (server/routers/model.router.ts:141). All fields optional with
 *                  server defaults, so `{ limit }` is a valid input.
 *                  getModelsInfiniteHandler returns { items, nextCursor }
 *                  (server/controllers/model.controller.ts:27 `return { items,
 *                  nextCursor }`); each item carries a numeric `id`.
 *
 * Tolerant on COUNT, strict on STRUCTURE: the prod-clone dev DB has real content
 * but we never assume specific models/titles. We assert ">= 1 item with a numeric
 * id" — the structural intent is "the feed produced a real, non-empty page of
 * identifiable content", not any particular row. An empty browse feed is itself
 * the regression this spec exists to catch, so keep the non-empty assertion.
 *
 * ── Why the IMAGES feed is NOT asserted here (deliberately scoped out) ──────────
 * The /images feed (image.getInfinite, broad/unfiltered) does NOT reliably read
 * the DB in a preview: getInfiniteImagesHandler routes a broad query (no
 * postId/modelId/collection/reaction filter → requiresDbPath=false) through
 * getAllImagesIndex — the MEILISEARCH-backed index path — whenever
 * `features.imageIndexFeed` or the BitDex Flipt flag (BITDEX_IMAGE_SEARCH) is on,
 * which is the production-like default (src/server/controllers/image.controller.ts
 * :300-320). That path hits an image search index the preview doesn't populate and
 * then hydrates from the dev clone, so a broad image.getInfinite returns flaky /
 * empty results in preview (observed: 3 items once, 0 items on two consecutive
 * smoke runs). This is the SAME external-index limitation site search has — see the
 * search note pattern — so we don't ship an assertion that flakes on infra the
 * preview doesn't own. The DB-backed models feed above is the solid, self-contained
 * signal.
 *
 * FOLLOW-UP for reliable image-feed coverage (not done here): scope the query so
 * `requiresDbPath` is true (e.g. `image.getInfinite { modelId }` — bare modelId
 * forces getAllImages/DB per image.controller.ts:303), seeding the modelId at
 * runtime from this models feed; or stand up a preview-local image index.
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + minted states).
 */

const ROLE = 'tester' as const;

// A small page is all we need to prove "the feed renders content"; keep it light
// on the single-replica preview pod (the suite runs serially, workers:1).
const FEED_LIMIT = 5;

test.describe('browse feed renders real content (tester)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('model.getAll (the /models feed) returns a non-empty page of models', async ({ page }) => {
    // Warm the request context against the preview origin so page.request shares the
    // auth cookie + a real navigated origin (preview-trpc stamps Origin/Referer for
    // the CSRF gate, but navigating once is the safe baseline — mirrors the other
    // tRPC-driven preview specs). domcontentloaded only: NEVER networkidle — the
    // app's background traffic never idles, so a networkidle nav hangs to timeout.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const data = await trpcQuery<{ items: Array<{ id: number }> }>(
      page.request,
      'model.getAll',
      { limit: FEED_LIMIT }
    );

    const items = data?.items ?? [];
    // STRUCTURE: a real, non-empty page came back. An empty models feed is the
    // exact regression this catches (broken handler / over-aggressive filter / 500).
    expect(Array.isArray(items), 'model.getAll should return an items array').toBe(true);
    expect(items.length, 'the models feed should render >= 1 model card').toBeGreaterThan(0);
    // Each rendered card needs an identifiable model — assert the first item is a
    // real row (numeric id), not a malformed/placeholder entry.
    expect(typeof items[0]?.id, 'a feed model should carry a numeric id').toBe('number');
  });
});
