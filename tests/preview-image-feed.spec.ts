import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';
import { retryFlaky } from './preview-retry';

/**
 * Image-feed content smoke: the real /images browse feed actually renders content.
 *
 * preview-feed.spec.ts covers the models feed (model.getAll, DB-backed) but
 * deliberately skipped images. This adds the images half against the ACTUAL feed:
 *
 *  - A broad image.getInfinite (no entity filter) routes server-side through
 *    getAllImagesIndex — the MEILISEARCH index path (image.controller.ts:300-320),
 *    not the DB. The index `metrics_images_v1` (~114M docs) lives on the in-cluster
 *    feeds-meilisearch (civitai-feeds-proxy), and previews reach it via
 *    METRICS_SEARCH_HOST=http://civitai-feeds-proxy.civitai-feeds.svc.cluster.local
 *    (same host prod uses; verified both feeds backends populated 2026-06-11). So
 *    the broad feed IS available to previews and this asserts the real /images
 *    surface end to end (meili query + DB hydration).
 *
 * Why NOT a modelId-scoped DB query instead: a bare-modelId image.getInfinite
 * forces the DB path (getAllImages), but that scan over the 115M-row dev clone
 * takes >60s per model and blew the test timeout — the index path is both the real
 * feed AND the fast/reliable one (~3s). (An earlier 1-core preview pod
 * intermittently returned 0 from the broad feed — suspected server-side abort under
 * CPU throttle; on the 2-core pod, post the CPU bump, it returns content in ~3s.)
 *
 * Runs as `tester` (free member that PASSES the preview gate). image.getInfinite is
 * a heavyProcedure, reachable for a gate-passing user. page.request carries the
 * storageState auth cookie; preview-trpc stamps Origin/Referer for the CSRF gate —
 * same authed-tRPC pattern as the sibling preview-feed / preview-engagement specs.
 *
 * Verified tRPC shape: image.getInfinite (server/routers/image.router.ts:126),
 * input getInfiniteImagesSchema; `{ limit }` valid (all fields defaulted), returns
 * { items: [{ id }], nextCursor }.
 *
 * Tolerant on COUNT, strict on STRUCTURE: assert ">= 1 image with a numeric id" —
 * the structural intent is "the /images feed produced a real, non-empty page", not
 * any specific image. An empty feed is the regression this guards. NOTE: this path
 * depends on the shared feeds-meilisearch being healthy; a feeds incident could
 * make it (report-only) flake — that's the accepted cost of covering the real feed
 * rather than a synthetic DB query.
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + minted states).
 */

const ROLE = 'tester' as const;
const FEED_LIMIT = 5;

test.describe('images browse feed renders real content (tester)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('image.getInfinite (the /images feed via meili) returns a non-empty page', async ({
    page,
  }) => {
    // Warm the request context against the preview origin (auth cookie + a real
    // navigated origin). domcontentloaded only: NEVER networkidle — the app's
    // background traffic never idles, so a networkidle nav hangs to timeout.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // image.getInfinite is meili-backed via the shared in-cluster feeds-proxy, which
    // intermittently returns HTTP 408 ("Image search is temporarily overloaded —
    // please retry") under concurrent preview-build load. The app's own error tells
    // us to retry; Playwright's whole-test retries fire within seconds (all <5s) so
    // they don't outlast the overload. retryFlaky spaces the retries with backoff to
    // ride it out — honest: a sustained overload still fails after the attempts.
    const data = await retryFlaky('image.getInfinite feed', () =>
      trpcQuery<{ items: Array<{ id: number }> }>(page.request, 'image.getInfinite', {
        limit: FEED_LIMIT,
      })
    );

    const items = data?.items ?? [];
    expect(Array.isArray(items), 'image.getInfinite returns an items array').toBe(true);
    expect(
      items.length,
      'the /images feed (meili-backed) should render >= 1 image'
    ).toBeGreaterThan(0);
    expect(typeof items[0]?.id, 'a feed image should carry a numeric id').toBe('number');
  });
});
