import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';
import { retryFlaky } from './preview-retry';

/**
 * Image-feed smoke: the real /images browse feed answers from the source this deploy has.
 *
 * preview-feed.spec.ts covers the models feed (model.getAll, DB-backed). This covers the
 * images half: a broad image.getInfinite (no entity filter) goes through getAllImagesIndex,
 * and the page carries `source` on the wire (image.controller.ts) naming who answered:
 *
 *  - `feed` — the feed service (FEED_SERVICE_URL set; production). Must be a real,
 *    non-empty page.
 *  - `meili` — the search-index path. The feeds index (`metrics_images_v1`) is retired
 *    (civitai#7054): nothing writes to it, so its readers answer an empty page rather than
 *    serve frozen moderation fields. Previews set no FEED_SERVICE_URL, so this is what a
 *    preview gets, and the test asserts that contract: an empty page, not an error and
 *    not stale rows. If previews gain a feed service, `source` becomes `feed` and the
 *    non-empty assertion applies instead.
 *  - `db` — the Postgres path (imageIndexFeed off). Must be non-empty.
 *
 * Runs as `tester` (free member that PASSES the preview gate). image.getInfinite is a
 * heavyProcedure, reachable for a gate-passing user. page.request carries the storageState
 * auth cookie; preview-trpc stamps Origin/Referer for the CSRF gate — same authed-tRPC
 * pattern as the sibling preview-feed / preview-engagement specs.
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + minted states).
 */

const ROLE = 'tester' as const;
const FEED_LIMIT = 5;

test.describe('images browse feed renders real content (tester)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('image.getInfinite answers from its source: a feed page, or empty from the retired index', async ({
    page,
  }) => {
    // Warm the request context against the preview origin (auth cookie + a real
    // navigated origin). domcontentloaded only: NEVER networkidle — the app's
    // background traffic never idles, so a networkidle nav hangs to timeout.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The feed and index paths can answer a retryable 503 under load; retryFlaky spaces
    // the retries with backoff. A sustained failure still fails after the attempts.
    const data = await retryFlaky('image.getInfinite feed', () =>
      trpcQuery<{ items: Array<{ id: number }>; source?: string }>(
        page.request,
        'image.getInfinite',
        { limit: FEED_LIMIT }
      )
    );

    const items = data?.items ?? [];
    const source = data?.source;
    expect(Array.isArray(items), 'image.getInfinite returns an items array').toBe(true);
    expect(['feed', 'meili', 'db'], 'the page names the source that answered it').toContain(source);

    if (source === 'meili') {
      // No feed service on this deploy: the retired feeds index must not be read.
      expect(
        items,
        'the retired metrics_images_v1 index answers an empty page, never stale rows'
      ).toEqual([]);
      return;
    }

    expect(
      items.length,
      `the /images feed (source=${source}) should render >= 1 image`
    ).toBeGreaterThan(0);
    expect(typeof items[0]?.id, 'a feed image should carry a numeric id').toBe('number');
  });
});
