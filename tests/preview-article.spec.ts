import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery, uniqueToken } from './preview-trpc';

/**
 * Mutation smoke: the article authoring write path (article.upsert) — a distinct
 * content type (the /articles section) not otherwise covered by the suite.
 *
 * Fully API-driven + per-run self-seeded (same pattern as preview-engagement /
 * preview-collections): the moderator fixture creates its OWN article carrying a unique
 * token, reads it back by id to prove it persisted, then best-effort deletes it.
 * No dependency on shared content, no collision on the dev clone across concurrent
 * previews (each run's article is unique; we never touch a shared entity — unlike
 * e.g. a follow edge, which would be a shared row).
 *
 * Runs as `mod` (the moderator fixture). article.upsert is rate-limited by
 * articleRateLimits — a HARD `limit: 1 / day` per user (plus 0/hour for accounts
 * created <24h ago). The ci-smoke fixtures are shared across ALL concurrent
 * previews, so a non-mod fixture would exhaust the 1/day quota after the first
 * preview run and every later one would 429. The rateLimit middleware bypasses
 * moderators entirely (`if (ctx.user?.isModerator) return next()` —
 * middleware.trpc.ts), so running as `mod` is the only way to author an article
 * reliably from the shared fixtures. (`mod` clears the same gates: guarded
 * onboarding=15, and isFlagProtected('articleCreate') = `['public']`.)
 * article.getById is publicProcedure; article.delete is protected (owner may delete).
 *
 * Verified tRPC shapes (civitai repo, paths relative to civitai/src):
 *  - article.upsert    guarded; input upsertArticleInput (article.schema.ts:90):
 *    `title` (z.string().min(1).max(100)) + non-empty sanitized `content` are the
 *    only required fields, everything else optional. upsertArticleHandler →
 *    upsertArticle returns the created article incl. numeric `.id`. (No publishedAt
 *    => it stays a draft, which is fine — we verify by id, not by listing.)
 *  - article.getById   public; input getByIdSchema ({ id: number }); returns the
 *    article (getArticleById) incl. `.title` — we assert our token survived into it.
 *  - article.delete    protected; input getByIdSchema ({ id }); owner-only cleanup.
 */

const ROLE = 'mod' as const;

test.describe('mod authors an article (mutation flow)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('article.upsert creates a draft, verified by getById read-back', async ({ page }) => {
    // Warm the request context against the preview origin so page.request shares the
    // auth cookie + a real navigated origin (preview-trpc stamps Origin/Referer for
    // the CSRF gate, but navigating once is the safe baseline). domcontentloaded
    // only: NEVER networkidle — the app's background traffic never idles.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('article'); // ~31 chars, well under the 100-char title cap

    // 1. Create a draft article carrying the unique token in its title + content.
    const article = await trpcMutation<{ id: number } | null>(page.request, 'article.upsert', {
      title: token,
      content: `<p>${token}</p>`,
    });
    expect(typeof article?.id, 'article.upsert should return a numeric article id').toBe('number');

    // 2. DETERMINISTIC read-back: fetch the article by id and assert our token
    // survived into the stored title — proves the write persisted, not just 200-OK'd.
    const fetched = await trpcQuery<{ title?: string } | null>(page.request, 'article.getById', {
      id: article!.id,
    });
    expect(fetched?.title, 'getById should return the article with our seeded title').toBe(token);

    // 3. Best-effort cleanup so repeated runs don't accrete draft articles on the
    // shared dev clone. A delete failure must not fail the authoring assertions
    // above, which are the point of this spec.
    try {
      await trpcMutation(page.request, 'article.delete', { id: article!.id });
    } catch {
      // The create + read-back already passed; leftover-draft cleanup is non-critical.
    }
  });
});
