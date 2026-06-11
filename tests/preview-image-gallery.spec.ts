import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Image-content smoke (DB path): the image query actually returns real images for
 * browse content. This closes the gap preview-feed.spec.ts deliberately left open.
 *
 * Why this exists / why it's scoped to a model:
 *  - The BROAD /images feed (image.getInfinite with no entity filter) is served by
 *    the MEILISEARCH index path (getAllImagesIndex) under the prod-like default
 *    (features.imageIndexFeed / BitDex flag) — see image.controller.ts:300-320.
 *    The preview doesn't populate that index, so a broad image.getInfinite returns
 *    flaky/empty results in preview and can't be asserted on (same limitation as
 *    site search; preview-feed.spec.ts documents this and only covers the DB-backed
 *    models feed).
 *  - A query carrying a bare `modelId` (and no modelVersionId) sets requiresDbPath
 *    = true (image.controller.ts:306), so it runs through getAllImages — the DB
 *    path, with all the real nsfwLevel / ingestion / published filters — NOT the
 *    index. That IS reliable against the preview's dev-clone DB, and it exercises a
 *    real high-traffic surface: the model-detail image gallery.
 *
 * Strategy (self-contained, prod-clone-tolerant):
 *  1. model.getAll returns a page of real models the tester can see (proven by
 *     preview-feed.spec.ts — DB-backed, non-empty).
 *  2. For each model, query image.getInfinite { modelId } (DB path) until one
 *     returns >= 1 image. We don't assume any SPECIFIC model has gallery images
 *     (a given top model legitimately might not), so we scan a small page and
 *     assert that AT LEAST ONE real model resolves to >= 1 DB-backed image with a
 *     numeric id. That's the structural intent: "the image query returns real
 *     images from the DB for browse content", not any particular model/image.
 *
 * Runs as `tester` (free member that PASSES the preview gate). model.getAll is
 * publicProcedure and image.getInfinite is heavyProcedure — both reachable for a
 * gate-passing user. page.request carries the storageState auth cookie; preview-trpc
 * stamps Origin/Referer for the CSRF gate. Same authed-tRPC pattern as the sibling
 * preview-feed / preview-engagement specs.
 *
 * Verified tRPC shapes (civitai repo, paths relative to civitai/src):
 *  - model.getAll       publicProcedure (server/routers/model.router.ts:141);
 *                       `{ limit }` valid, returns { items: [{ id }], nextCursor }.
 *  - image.getInfinite  heavyProcedure (server/routers/image.router.ts:126), input
 *                       getInfiniteImagesSchema; `{ limit, modelId }` valid (modelId
 *                       optional, all else defaulted). Bare modelId → DB path
 *                       (getAllImages) → { items: [{ id }], nextCursor }.
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + minted states).
 */

const ROLE = 'tester' as const;

// Scan up to this many models to find one with gallery images. Top models almost
// always have a showcase image, so this hits on the first 1-2 in practice; the cap
// keeps it light on the (serial, single-replica) preview pod while tolerating a few
// image-less models.
const MODELS_TO_SCAN = 8;
const IMAGE_LIMIT = 5;

test.describe('image gallery query returns real DB-backed images (tester)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('image.getInfinite scoped to a real modelId returns >= 1 image via the DB path', async ({
    page,
  }) => {
    // Warm the request context against the preview origin (auth cookie + a real
    // navigated origin). domcontentloaded only: NEVER networkidle — the app's
    // background traffic never idles, so a networkidle nav hangs to timeout.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // 1. Resolve real model ids from the (DB-backed, proven non-empty) models feed.
    const models = await trpcQuery<{ items: Array<{ id: number }> }>(
      page.request,
      'model.getAll',
      { limit: MODELS_TO_SCAN }
    );
    const modelIds = (models?.items ?? []).map((m) => m.id).filter((id) => typeof id === 'number');
    expect(modelIds.length, 'model.getAll should yield real model ids to scan').toBeGreaterThan(0);

    // 2. Find the first model whose gallery resolves to >= 1 DB-backed image. Bare
    // modelId forces getAllImages (the DB path), so this never touches the
    // preview-unpopulated Meilisearch index.
    let firstImageId: number | undefined;
    let scanned = 0;
    for (const modelId of modelIds) {
      scanned += 1;
      const gallery = await trpcQuery<{ items: Array<{ id: number }> }>(
        page.request,
        'image.getInfinite',
        { limit: IMAGE_LIMIT, modelId }
      );
      const imgs = gallery?.items ?? [];
      expect(Array.isArray(imgs), `image.getInfinite(modelId=${modelId}) returns an items array`).toBe(
        true
      );
      if (imgs.length > 0) {
        firstImageId = imgs[0]?.id;
        break;
      }
    }

    // STRUCTURE: at least one real model resolved to >= 1 image with a numeric id.
    // An empty result across every scanned model would mean the DB image query is
    // broken (handler/filter regression) — the regression this guards. If a future
    // preview legitimately ships image-less top models, raise MODELS_TO_SCAN.
    expect(
      typeof firstImageId,
      `at least one of ${scanned} scanned models should resolve to a DB-backed image with a numeric id`
    ).toBe('number');
  });
});
