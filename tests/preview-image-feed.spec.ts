import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';
import { retryFlaky } from './preview-retry';
import { imageFeedVerdict, type ImageFeedPage } from './preview-image-feed.verdict';

/**
 * Image-feed smoke: the real /images browse feed answers from the source this deploy has.
 *
 * preview-feed.spec.ts covers the models feed (model.getAll, DB-backed). This covers the
 * images half: a broad image.getInfinite (no entity filter) goes through getAllImagesIndex,
 * and the page carries `source` on the wire (image.controller.ts) naming who answered:
 *
 *  - `feed` / `db` / `meili` — someone answered the query: the page must be non-empty.
 *    Previews set no FEED_SERVICE_URL, so the Postgres query answers, as `db`.
 *  - `retired` — the empty shape a retired-index refusal answers; the only source under which
 *    an empty page passes. An empty page under any other source fails: it is what a feed that
 *    broke for some other reason would return.
 *
 * The verdict lives in preview-image-feed.verdict.ts, with its unit test in
 * src/server/services/__tests__/preview-image-feed-verdict.test.ts.
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

  test('image.getInfinite answers from its source: a real page, or the retired-index refusal', async ({
    page,
  }) => {
    // Warm the request context against the preview origin (auth cookie + a real
    // navigated origin). domcontentloaded only: NEVER networkidle — the app's
    // background traffic never idles, so a networkidle nav hangs to timeout.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The feed and index paths can answer a retryable 503 under load; retryFlaky spaces
    // the retries with backoff. A sustained failure still fails after the attempts.
    const data = await retryFlaky('image.getInfinite feed', () =>
      trpcQuery<ImageFeedPage>(page.request, 'image.getInfinite', { limit: FEED_LIMIT })
    );

    expect(imageFeedVerdict(data), 'image.getInfinite page vs the source it names').toBeNull();
  });
});
