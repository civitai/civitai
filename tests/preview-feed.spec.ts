import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Feed-content smoke: the core BROWSE path actually renders real content.
 *
 * preview-smoke.spec.ts only proves /models and /images LOAD (HTTP <400, not
 * bounced to /login or /preview-restricted) — it never asserts the feed returns
 * any items. An empty-feed or broken-list regression (a busted model.getAll /
 * image.getInfinite handler, a query that 500s, a filter that nukes every row)
 * passes every preview spec today while shipping a blank site. This closes that
 * gap by asserting the two backing feed queries return a non-empty, structurally
 * valid page of content.
 *
 * Why tRPC instead of scraping cards out of the DOM:
 *  - The /models and /images feeds are exactly these two queries — model.getAll
 *    backs the models feed (src/components/Model/model.utils.ts:145
 *    `trpc.model.getAll.useInfiniteQuery`) and image.getInfinite backs the images
 *    feed (src/components/Image/Infinite/ImagesInfinite.tsx:131 getQueryKey(
 *    trpc.image.getInfinite)). Asserting the query result is asserting the same
 *    data the card grid renders, minus the flaky virtualized-list / lazy-image
 *    DOM surface (cards mount on scroll/intersection, image <Card>s have no stable
 *    testid) — a DOM-card count would be the brittle proxy here, not the source of
 *    truth.
 *  - Self-contained against the preview's OWN dev-clone DB: no external service,
 *    no scroll timing, no networkidle (which never settles — see gotchas below).
 *
 * Runs as `tester` (a free member that PASSES the preview gate). Both queries are
 * reachable for a gate-passing user: model.getAll is publicProcedure and
 * image.getInfinite is heavyProcedure (no moderator/paid requirement). page.request
 * carries the test's storageState auth cookie, and preview-auth.middleware gates
 * /api/trpc/* (only /api/auth, /login, /preview-restricted, /_next, /favicon are
 * exempt — middleware matcher '/:path*'), so the authed cookie is what lets these
 * calls through the gate — same authed-tRPC pattern as preview-engagement.spec.ts.
 *
 * Verified tRPC shapes (civitai repo, paths relative to civitai/src):
 *  - model.getAll        publicProcedure, input getAllModelsSchema (minus `page`)
 *                        (server/routers/model.router.ts:141). All fields optional
 *                        with server defaults, so `{ limit }` is a valid input.
 *                        getModelsInfiniteHandler returns { items, nextCursor }
 *                        (server/controllers/model.controller.ts:27 `return { items,
 *                        nextCursor }`); each item carries a numeric `id`.
 *  - image.getInfinite   heavyProcedure, input getInfiniteImagesSchema
 *                        (server/routers/image.router.ts:126). Every field has a
 *                        default (limit/period/sort/include…), so `{ limit }` is a
 *                        valid input. getInfiniteImagesHandler returns { items,
 *                        nextCursor } off getAllImages / getAllImagesIndex
 *                        (server/controllers/image.controller.ts:274); each item
 *                        carries a numeric `id`.
 *
 * Both verified live against a deployed preview (model.getAll + image.getInfinite
 * each returned 3 real items with numeric ids on pr-2472.civitaic.com).
 *
 * SEARCH is INTENTIONALLY NOT asserted here. Investigated: site search is
 * browser-side InstantSearch pointed at NEXT_PUBLIC_SEARCH_HOST, which on a
 * preview resolves to the PROD Meilisearch (search-new.civitai.com), NOT a
 * preview-local index. So a search assertion would (a) depend on an EXTERNAL prod
 * service the preview doesn't own — a prod search incident would flake this
 * report-only spec and emit false signal; (b) query a versioned index UID
 * (models_v9) that rotates over time, brittle to hardcode; and (c) read prod data,
 * not the preview's dev clone, so it wouldn't even validate the PR's own content.
 * The feed-renders-content core above is the solid, self-contained value; search
 * is the uncertain extension and is deliberately dropped per the suite's
 * "don't ship a spec that flakes because search isn't wired to the preview" rule.
 * (To add search later, do it against a preview-local Meilisearch, not prod.)
 *
 * Tolerant on COUNT, strict on STRUCTURE: the prod-clone dev DB has real content
 * but we never assume specific models/images/titles. We assert ">= 1 item with a
 * numeric id" — the structural intent is "the feed produced a real, non-empty page
 * of identifiable content", not any particular row. To widen if a future preview
 * legitimately ships an empty feed, relax `toBeGreaterThan(0)` to a shape-only
 * check (Array.isArray) — but an empty browse feed is itself the regression this
 * spec exists to catch, so keep the non-empty assertion unless that changes.
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

  test('image.getInfinite (the /images feed) returns a non-empty page of images', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const data = await trpcQuery<{ items: Array<{ id: number }> }>(
      page.request,
      'image.getInfinite',
      { limit: FEED_LIMIT }
    );

    const items = data?.items ?? [];
    // Same structural intent as the models feed: a non-empty page of identifiable
    // images is what the /images card grid renders; an empty result is the
    // regression we're guarding.
    expect(Array.isArray(items), 'image.getInfinite should return an items array').toBe(true);
    expect(items.length, 'the images feed should render >= 1 image card').toBeGreaterThan(0);
    expect(typeof items[0]?.id, 'a feed image should carry a numeric id').toBe('number');
  });
});
