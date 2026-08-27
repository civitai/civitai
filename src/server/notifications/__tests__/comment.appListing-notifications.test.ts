import { describe, expect, it } from 'vitest';
import {
  commentNotifications,
  threadTypeLabel,
  threadUrlMap,
  withIndefiniteArticle,
} from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';

/**
 * App-store-listing (`appListing`) comment threads: MENTIONS and REPLIES now notify.
 *
 * 🔴 THIS FILE IS A DELIBERATE INVERSION of `comment.appListing-exclusion.test.ts`, which it
 * replaces (git tracks it as a rename). That file PINNED the opposite contract — that
 * `new-comment-reply`, `new-thread-response` and `new-mention` all carried an
 * `appListingId IS NULL` guard and that `threadUrlMap` returned `undefined` for such a thread.
 * The exclusion existed for one reason: app-listing pages are addressed by SLUG
 * (`/apps/store-preview/<slug>`) while the notification queries only had
 * `app_listings.serial_id` (the integer CommentsV2 thread key), so any notification they emitted
 * would have carried `url: undefined`. Joining the slug in removes that reason, so the guards go.
 *
 * What is asserted here, and why each shape:
 *   - the WHOLE resolved URL, never a substring — `toContain('apps')` is satisfied by a
 *     wrong-but-similar URL, and by `/apps/store-preview/undefined`.
 *   - a positive AND a negative control on `threadUrlMap`, so "appListing resolves" cannot be
 *     passed by a map that answers for everything.
 *   - every pre-existing thread type, unchanged, at full-string precision — a regression there
 *     breaks notification links site-wide, which is the expensive failure mode.
 *   - the generated SQL with COMMENTS STRIPPED FIRST. `--` makes "the token is present" and
 *     "the clause is live" different facts, so a guard that was commented out rather than
 *     deleted must still fail these.
 *
 * Fixture values are non-default and pairwise distinct so a mutant that binds the wrong one
 * (threadParentId where the slug belongs, commentId where threadId belongs) produces a
 * DIFFERENT string rather than the same one by coincidence.
 */

type Def = {
  prepareQuery: (args: { lastSent: string }) => string;
  prepareMessage: (n: any) => { message: string; url?: string } | undefined;
};
const commentDefs = commentNotifications as unknown as Record<string, Def>;
const mentionDefs = mentionNotifications as unknown as Record<string, Def>;

const LAST_SENT = '2026-01-01T00:00:00.000Z';

/** Every id distinct from every other, and none of them 0/1/undefined. */
const IDS = {
  commentId: 8123,
  threadId: 4471,
  commentParentId: 9052,
  threadParentId: 3310,
} as const;

const SLUG = 'pixel-forge';

/** The query string every `threadUrlMap` entry appends, spelled out rather than recomputed. */
const QUERY = 'highlight=8123&commentParentType=comment&commentParentId=9052&threadId=4471';

const details = (over: Record<string, unknown> = {}) => ({
  ...IDS,
  commentParentType: 'comment',
  username: 'ada',
  version: 2,
  ...over,
});

const appListingDetails = (over: Record<string, unknown> = {}) =>
  details({ threadType: 'appListing', threadParentId: null, appListingSlug: SLUG, ...over });

/**
 * Comment-stripped, indentation-collapsed SQL.
 *
 * Stripping `--` and block comments BEFORE asserting is the whole point: a guard left in place
 * as a comment still matches a naive `toContain`, and would read as live.
 *
 * (Limitation, stated rather than hidden: this is a lexical strip, so a `--` inside a string
 * literal would truncate that line. None of the three queries under test contains one — they
 * carry only `'%"mention:%'` and ISO dates.)
 */
const normalizeSql = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

describe('threadUrlMap — appListing resolves by slug', () => {
  it('POSITIVE control: an appListing thread resolves to the real listing URL', () => {
    expect(threadUrlMap(appListingDetails())).toBe(`/apps/store-preview/${SLUG}?${QUERY}`);
  });

  it('NEGATIVE control: a genuinely unknown thread type is still undefined', () => {
    // The fix must not turn the map into something that answers for everything. Both an
    // entity type that has never been addressable and a nonsense one stay unresolved.
    expect(threadUrlMap(details({ threadType: 'clubPost' }))).toBeUndefined();
    expect(threadUrlMap(details({ threadType: 'comicProject' }))).toBeUndefined();
    expect(threadUrlMap(details({ threadType: 'notAThing' }))).toBeUndefined();
    // ...including one carrying a slug, so the slug alone cannot unlock an entry.
    expect(
      threadUrlMap(details({ threadType: 'notAThing', appListingSlug: SLUG }))
    ).toBeUndefined();
  });

  it('the `comment` fallback (an unaddressable Thread entity) is still undefined', () => {
    // This is the arm the SQL falls back to when nothing else matched. It must NOT have been
    // co-opted into resolving app listings.
    expect(threadUrlMap(details({ threadType: 'comment', threadParentId: null }))).toBeUndefined();
    expect(threadUrlMap(details({ threadType: 'comment', appListingSlug: SLUG }))).toBeUndefined();
  });

  it('a missing / null / empty slug yields NO url rather than a broken link', () => {
    // `/apps/store-preview/undefined` is a 404 that looks like a working notification.
    for (const appListingSlug of [undefined, null, '']) {
      expect(threadUrlMap(appListingDetails({ appListingSlug }))).toBeUndefined();
    }
  });

  it('the slug is URL-encoded (defensive — slugs are url-safe today)', () => {
    expect(threadUrlMap(appListingDetails({ appListingSlug: 'a b/c' }))).toBe(
      `/apps/store-preview/a%20b%2Fc?${QUERY}`
    );
  });

  it('REGRESSION: every pre-existing thread type resolves EXACTLY as before', () => {
    // Full strings, not substrings. A mutant that reorders the query string, drops the
    // `dialog=commentThread` on models, or binds the slug in place of `threadParentId`
    // changes one of these.
    const resolved = Object.fromEntries(
      [
        'model',
        'image',
        'post',
        'article',
        'review',
        'bounty',
        'bountyEntry',
        'challenge',
        'comicChapter',
        'model3d',
      ].map((threadType) => [threadType, threadUrlMap(details({ threadType }))])
    );

    expect(resolved).toEqual({
      model: `/models/3310?dialog=commentThread&${QUERY}`,
      image: `/images/3310?${QUERY}`,
      post: `/posts/3310?${QUERY}`,
      article: `/articles/3310?${QUERY}`,
      review: `/reviews/3310?${QUERY}`,
      bounty: `/bounties/3310?${QUERY}`,
      bountyEntry: `/bounties/entries/3310?${QUERY}`,
      challenge: `/challenges/3310?${QUERY}`,
      comicChapter: `/comics/3310?${QUERY}`,
      model3d: `/3d-models/3310?${QUERY}`,
    });
  });

  it('REGRESSION: an appListing payload does not disturb a sibling type on the same details', () => {
    // A stale-binding mutant (reading `appListingSlug` unconditionally) would corrupt these.
    expect(threadUrlMap(details({ threadType: 'model', appListingSlug: SLUG }))).toBe(
      `/models/3310?dialog=commentThread&${QUERY}`
    );
    expect(threadUrlMap(details({ threadType: 'image', appListingSlug: SLUG }))).toBe(
      `/images/3310?${QUERY}`
    );
  });
});

describe('prepareMessage — an appListing thread produces a linked notification', () => {
  it('new-mention: exact URL + human-readable copy', () => {
    const msg = mentionDefs['new-mention'].prepareMessage({
      type: 'new-mention',
      details: appListingDetails({ mentionedIn: 'comment' }),
    });

    expect(msg).toEqual({
      message: 'ada mentioned you in a comment on an app listing',
      url: `/apps/store-preview/${SLUG}?${QUERY}`,
    });
  });

  // 🔴 SECOND DELIBERATE INVERSION IN THIS FILE. The first version of these two assertions
  // pinned `'ada replied to a appListing comment you made'` and
  // `"ada responded to a App Listing thread you're in"` — the raw entity key and a Title-Cased
  // key, each behind a hardcoded "a". That was a real defect shipped as an intended contract:
  // the label existed but only `new-mention` used it. Both consumers now read the same shared
  // `threadTypeLabel` + `withIndefiniteArticle`, so all three sentences name a thread the same
  // way and the article agrees with the noun.
  it('new-comment-reply: exact URL + human-readable copy', () => {
    const msg = commentDefs['new-comment-reply'].prepareMessage({
      type: 'new-comment-reply',
      details: appListingDetails(),
    });

    expect(msg).toEqual({
      message: 'ada replied to an app listing comment you made',
      url: `/apps/store-preview/${SLUG}?${QUERY}`,
    });
  });

  it('new-thread-response: exact URL + human-readable copy', () => {
    const msg = commentDefs['new-thread-response'].prepareMessage({
      type: 'new-thread-response',
      details: appListingDetails(),
    });

    expect(msg).toEqual({
      message: "ada responded to an app listing thread you're in",
      url: `/apps/store-preview/${SLUG}?${QUERY}`,
    });
  });

  it('all three emit NO url when the slug is missing (no broken-link notification)', () => {
    const noSlug = appListingDetails({ appListingSlug: null });
    expect(
      mentionDefs['new-mention'].prepareMessage({
        type: 'new-mention',
        details: { ...noSlug, mentionedIn: 'comment' },
      })?.url
    ).toBeUndefined();
    expect(
      commentDefs['new-comment-reply'].prepareMessage({
        type: 'new-comment-reply',
        details: noSlug,
      })?.url
    ).toBeUndefined();
    expect(
      commentDefs['new-thread-response'].prepareMessage({
        type: 'new-thread-response',
        details: noSlug,
      })?.url
    ).toBeUndefined();
  });

  it('REGRESSION: a model mention still resolves and still reads correctly', () => {
    expect(
      mentionDefs['new-mention'].prepareMessage({
        type: 'new-mention',
        details: details({ threadType: 'model', mentionedIn: 'comment' }),
      })
    ).toEqual({
      message: 'ada mentioned you in a comment on a model',
      url: `/models/3310?dialog=commentThread&${QUERY}`,
    });
  });

  it('REGRESSION: the `comment` fallback still reads "comment thread" and still has no url', () => {
    expect(
      mentionDefs['new-mention'].prepareMessage({
        type: 'new-mention',
        details: details({ threadType: 'comment', mentionedIn: 'comment' }),
      })
    ).toEqual({
      message: 'ada mentioned you in a comment on a comment thread',
      url: undefined,
    });
  });
});

/**
 * The copy seam: three sentences, in two modules, that each name a thread.
 *
 * `new-mention` had a label for `appListing` and the two reply consumers did not, so the same
 * thread was "an app listing" in one notification and "a appListing" / "a App Listing" in the
 * others. Each consumer was individually tested and individually fine; nothing asserted the
 * RELATIONSHIP between them. These tests pin the relationship — every consumer, every reachable
 * thread type, at full-string precision.
 */
describe('thread naming is one rule shared by all three consumers', () => {
  /**
   * Every `threadType` the notification SQL can emit: the eleven CASE arms plus the `comment`
   * fallback. `question`/`answer` are filtered out of the thread-response and mention queries
   * but survive in new-comment-reply's CASE, so they are reachable and belong here.
   *
   * The expected noun is the entity key VERBATIM except the three the map translates, so this
   * table doubles as the negative control on the map: nine of the twelve must come back
   * untouched, which is what stops "translate `appListing`" turning into "translate everything".
   *
   * 🔴 `model3d → "3D model"` is a REORDERING, and it is the one label starting with a DIGIT.
   * The article is picked from the noun, and `'3'` is not in the vowel set, so `a 3D model` is
   * the correct output — asserted here rather than assumed, because "not a vowel" and "therefore
   * `a`" is exactly the kind of step that reads as obvious and is worth one line to pin.
   */
  const NOUNS: Record<string, string> = {
    image: 'an image',
    model: 'a model',
    post: 'a post',
    question: 'a question',
    answer: 'an answer',
    review: 'a review',
    article: 'an article',
    bounty: 'a bounty',
    bountyEntry: 'a bounty entry',
    challenge: 'a challenge',
    model3d: 'a 3D model',
    appListing: 'an app listing',
  };

  it('threadTypeLabel translates exactly three keys and passes everything else through', () => {
    expect(threadTypeLabel('appListing')).toBe('app listing');
    expect(threadTypeLabel('bountyEntry')).toBe('bounty entry');
    expect(threadTypeLabel('model3d')).toBe('3D model');

    // NEGATIVE control: it is a translation table, not a formatter. Anything it does not
    // declare comes back byte-identical.
    for (const key of ['model', 'image', 'post', 'article', 'comment', 'clubPost']) {
      expect(threadTypeLabel(key)).toBe(key);
    }

    // 🔴 And it must not answer for keys it never declared. An object-literal lookup returns a
    // truthy Function for these, which `??` does not catch — that is how a prototype key ends
    // up rendered into a user-facing sentence. `Map.get` returns undefined, so they pass through.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(threadTypeLabel(key)).toBe(key);
    }
  });

  it('withIndefiniteArticle picks the article from the noun, digits included', () => {
    expect(withIndefiniteArticle('app listing')).toBe('an app listing');
    expect(withIndefiniteArticle('image')).toBe('an image');
    // A DIGIT-initial noun is not a vowel, so it takes "a" — the `model3d → "3D model"`
    // reordering depends on this and it is asserted, not assumed.
    expect(withIndefiniteArticle('3D model')).toBe('a 3D model');
    expect(withIndefiniteArticle('model')).toBe('a model');
    expect(withIndefiniteArticle('bounty entry')).toBe('a bounty entry');
  });

  const forType = (threadType: string) =>
    threadType === 'appListing'
      ? appListingDetails()
      : details({ threadType, mentionedIn: 'comment' });

  it.each(Object.entries(NOUNS))(
    '%s → "%s" in all three sentences, with the article that noun requires',
    (threadType, noun) => {
      const d = { ...forType(threadType), mentionedIn: 'comment' };

      expect(
        mentionDefs['new-mention'].prepareMessage({ type: 'new-mention', details: d })?.message
      ).toBe(`ada mentioned you in a comment on ${noun}`);

      expect(
        commentDefs['new-comment-reply'].prepareMessage({ type: 'new-comment-reply', details: d })
          ?.message
      ).toBe(`ada replied to ${noun} comment you made`);

      expect(
        commentDefs['new-thread-response'].prepareMessage({
          type: 'new-thread-response',
          details: d,
        })?.message
      ).toBe(`ada responded to ${noun} thread you're in`);
    }
  );

  it.each(Object.keys(NOUNS))(
    '%s: the article agrees with the noun PRINTED, read back out of each message',
    (threadType) => {
      // Derived from the message string, never from the implementation — so a consumer that
      // reintroduces the raw entity key behind a hardcoded "a" fails here on its own terms.
      // "a appListing" is caught because the printed noun starts with a vowel and the printed
      // article does not match it. This is the assertion the shipped defect would have failed.
      const d = { ...forType(threadType), mentionedIn: 'comment' };
      const messages = [
        mentionDefs['new-mention'].prepareMessage({ type: 'new-mention', details: d })!.message,
        commentDefs['new-comment-reply'].prepareMessage({
          type: 'new-comment-reply',
          details: d,
        })!.message,
        commentDefs['new-thread-response'].prepareMessage({
          type: 'new-thread-response',
          details: d,
        })!.message,
      ];

      for (const message of messages) {
        const m = message.match(/\b(an?) ([a-zA-Z0-9]+)/g)!;
        // The LAST "a/an <word>" in each sentence is the thread noun (the mention sentence
        // opens with "a comment", which is the message's own word, not the thread's).
        const [article, word] = m[m.length - 1].split(' ');
        const expected = ['a', 'e', 'i', 'o', 'u'].includes(word[0].toLowerCase()) ? 'an' : 'a';
        expect(article, `"${message}" — "${article} ${word}"`).toBe(expected);
      }
    }
  );
});

describe('generated SQL — the blanket exclusion is gone, the slug join is live', () => {
  const queries = {
    'new-comment-reply': commentDefs['new-comment-reply'].prepareQuery({ lastSent: LAST_SENT }),
    'new-thread-response': commentDefs['new-thread-response'].prepareQuery({ lastSent: LAST_SENT }),
    'new-mention': mentionDefs['new-mention'].prepareQuery({ lastSent: LAST_SENT }),
  };

  it.each(Object.keys(queries))('%s: no blanket appListing exclusion survives', (name) => {
    const sql = normalizeSql(queries[name as keyof typeof queries]);

    // The three exact clauses the old contract required. Each must be absent as a STANDALONE
    // conjunct — that is what dropped every app-listing thread.
    expect(sql).not.toMatch(/AND\s+root\."appListingId"\s+IS\s+NULL\s*$/m);
    expect(sql).not.toMatch(/AND\s+t\."appListingId"\s+IS\s+NULL\s*$/m);
  });

  it.each(Object.keys(queries))('%s: joins app_listings and selects the slug', (name) => {
    const sql = normalizeSql(queries[name as keyof typeof queries]);

    expect(sql).toContain('LEFT JOIN "app_listings" al ON al."serial_id" =');
    expect(sql).toContain(`'appListingSlug', al.slug`);
    expect(sql).toContain(`WHEN al.slug IS NOT NULL THEN 'appListing'`);
  });

  // The whole normalised statement, pinned. A fragment assertion is satisfied by semantically
  // inverted SQL (a guard moved into the wrong conjunct, a join onto the wrong column, an arm
  // ordered after the `ELSE`); a full snapshot is not. Any SQL change here must be reviewed,
  // which is the intent.
  it('new-comment-reply: whole statement', () => {
    expect(normalizeSql(queries['new-comment-reply'])).toMatchInlineSnapshot(`
      "WITH new_comment_reply AS (
      SELECT DISTINCT
      pc."userId" "ownerId",
      JSONB_BUILD_OBJECT(
      'version', 2,
      'commentId', c.id,
      'threadId', c."threadId",
      'threadParentId', COALESCE(
      root."imageId",
      root."modelId",
      root."postId",
      root."questionId",
      root."answerId",
      root."reviewId",
      root."articleId",
      root."bountyId",
      root."bountyEntryId",
      root."challengeId",
      root."model3dId"
      ),
      'threadType', CASE
      WHEN root."imageId" IS NOT NULL THEN 'image'
      WHEN root."modelId" IS NOT NULL THEN 'model'
      WHEN root."postId" IS NOT NULL THEN 'post'
      WHEN root."questionId" IS NOT NULL THEN 'question'
      WHEN root."answerId" IS NOT NULL THEN 'answer'
      WHEN root."reviewId" IS NOT NULL THEN 'review'
      WHEN root."articleId" IS NOT NULL THEN 'article'
      WHEN root."bountyId" IS NOT NULL THEN 'bounty'
      WHEN root."bountyEntryId" IS NOT NULL THEN 'bountyEntry'
      WHEN root."challengeId" IS NOT NULL THEN 'challenge'
      WHEN root."model3dId" IS NOT NULL THEN 'model3d'
      WHEN al.slug IS NOT NULL THEN 'appListing'
      ELSE 'comment'
      END,
      'appListingSlug', al.slug,
      'commentParentId', t."commentId",
      'commentParentType', 'comment',
      'username', u.username
      ) "details"
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      JOIN "CommentV2" pc ON pc.id = t."commentId"
      JOIN "User" u ON c."userId" = u.id
      JOIN "Thread" root ON root.id = t."rootThreadId"
      LEFT JOIN "app_listings" al ON al."serial_id" = root."appListingId"
      WHERE c."createdAt" > '2026-01-01T00:00:00.000Z' AND c."userId" != pc."userId"
      AND NOT EXISTS (
      SELECT 1 FROM "UserEngagement" blk
      WHERE (blk."userId" = pc."userId" AND blk."targetUserId" = c."userId" AND blk.type IN ('Block', 'Hide'))
      OR (blk."userId" = c."userId" AND blk."targetUserId" = pc."userId" AND blk.type = 'Block')
      )
      AND NOT EXISTS (
      WITH RECURSIVE muteable_threads AS (
      SELECT t.id "id", 0 "depth"
      UNION
      SELECT "parentId", mt."depth" + 1
      FROM muteable_threads mt
      JOIN "Thread" th ON th.id = mt."id"
      CROSS JOIN LATERAL unnest(ARRAY[
      th."parentThreadId",
      (SELECT pc."threadId" FROM "CommentV2" pc WHERE pc.id = th."commentId")
      ]) AS "parentId"
      WHERE "parentId" IS NOT NULL AND mt."depth" < 100
      )
      SELECT 1
      FROM muteable_threads mt
      JOIN "ThreadMute" tm ON tm."threadId" = mt."id"
      WHERE tm."userId" = pc."userId"
      )
      AND (root."appListingId" IS NULL OR al.slug IS NOT NULL)
      )
      SELECT
      concat('new-comment-reply:owner:v2:', details->>'commentId') "key",
      case
      when details->>'version' is null then concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId')
      when details->>'threadType' <> 'comment' then concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId')
      end "dedupeKey",
      "ownerId"    "userId",
      'new-comment-reply' "type",
      details
      FROM new_comment_reply r
      WHERE
      NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-reply')"
    `);
  });

  it('new-thread-response: whole statement', () => {
    expect(normalizeSql(queries['new-thread-response'])).toMatchInlineSnapshot(`
      "WITH new_thread_response AS (
      SELECT DISTINCT
      UNNEST((SELECT ARRAY_AGG("userId") FROM "Comment" cu WHERE cu."parentId" = c."parentId" AND cu."userId" != c."userId" AND NOT EXISTS (
      SELECT 1 FROM "UserEngagement" blk
      WHERE (blk."userId" = cu."userId" AND blk."targetUserId" = c."userId" AND blk.type IN ('Block', 'Hide'))
      OR (blk."userId" = c."userId" AND blk."targetUserId" = cu."userId" AND blk.type = 'Block')
      ))) "ownerId",
      JSONB_BUILD_OBJECT(
      'modelId', c."modelId",
      'commentId', c.id,
      'parentId', c."parentId",
      'parentType', 'comment',
      'modelName', m.name,
      'username', u.username
      ) "details"
      FROM "Comment" c
      JOIN "Model" m ON m.id = c."modelId"
      JOIN "User" u ON c."userId" = u.id
      WHERE c."parentId" IS NOT NULL AND c."createdAt" > '2026-01-01T00:00:00.000Z'
      UNION
      SELECT DISTINCT
      UNNEST((SELECT ARRAY_AGG("userId") FROM "CommentV2" cu WHERE cu."threadId" = c."threadId" AND cu."userId" != c."userId" AND NOT EXISTS (
      SELECT 1 FROM "UserEngagement" blk
      WHERE (blk."userId" = cu."userId" AND blk."targetUserId" = c."userId" AND blk.type IN ('Block', 'Hide'))
      OR (blk."userId" = c."userId" AND blk."targetUserId" = cu."userId" AND blk.type = 'Block')
      ) AND NOT EXISTS (
      WITH RECURSIVE muteable_threads AS (
      SELECT t.id "id", 0 "depth"
      UNION
      SELECT "parentId", mt."depth" + 1
      FROM muteable_threads mt
      JOIN "Thread" th ON th.id = mt."id"
      CROSS JOIN LATERAL unnest(ARRAY[
      th."parentThreadId",
      (SELECT pc."threadId" FROM "CommentV2" pc WHERE pc.id = th."commentId")
      ]) AS "parentId"
      WHERE "parentId" IS NOT NULL AND mt."depth" < 100
      )
      SELECT 1
      FROM muteable_threads mt
      JOIN "ThreadMute" tm ON tm."threadId" = mt."id"
      WHERE tm."userId" = cu."userId"
      ))) "ownerId",
      JSONB_BUILD_OBJECT(
      'version', 2,
      'commentId', c.id,
      'threadId', c."threadId",
      'threadParentId', COALESCE(
      root."imageId",
      root."modelId",
      root."postId",
      root."questionId",
      root."answerId",
      root."reviewId",
      root."articleId",
      root."bountyId",
      root."bountyEntryId",
      root."challengeId",
      root."model3dId",
      t."imageId",
      t."modelId",
      t."postId",
      t."questionId",
      t."answerId",
      t."reviewId",
      t."articleId",
      t."bountyId",
      t."bountyEntryId",
      t."challengeId",
      t."model3dId"
      ),
      'threadType', CASE
      WHEN COALESCE(root."imageId", t."imageId") IS NOT NULL THEN 'image'
      WHEN COALESCE(root."modelId", t."modelId") IS NOT NULL THEN 'model'
      WHEN COALESCE(root."postId", t."postId") IS NOT NULL THEN 'post'
      WHEN COALESCE(root."questionId", t."questionId") IS NOT NULL THEN 'question'
      WHEN COALESCE(root."answerId", t."answerId") IS NOT NULL THEN 'answer'
      WHEN COALESCE(root."reviewId", t."reviewId") IS NOT NULL THEN 'review'
      WHEN COALESCE(root."articleId", t."articleId") IS NOT NULL THEN 'article'
      WHEN COALESCE(root."bountyId", t."bountyId") IS NOT NULL THEN 'bounty'
      WHEN COALESCE(root."bountyEntryId", t."bountyEntryId") IS NOT NULL THEN 'bountyEntry'
      WHEN COALESCE(root."challengeId", t."challengeId") IS NOT NULL THEN 'challenge'
      WHEN COALESCE(root."model3dId", t."model3dId") IS NOT NULL THEN 'model3d'
      WHEN al.slug IS NOT NULL THEN 'appListing'
      ELSE 'comment'
      END,
      'appListingSlug', al.slug,
      'commentParentId', COALESCE(
      t."imageId",
      t."modelId",
      t."postId",
      t."questionId",
      t."answerId",
      t."reviewId",
      t."articleId",
      t."bountyId",
      t."bountyEntryId",
      t."challengeId",
      t."model3dId",
      t."commentId"
      ),
      'commentParentType', CASE
      WHEN t."imageId" IS NOT NULL THEN 'image'
      WHEN t."modelId" IS NOT NULL THEN 'model'
      WHEN t."postId" IS NOT NULL THEN 'post'
      WHEN t."questionId" IS NOT NULL THEN 'question'
      WHEN t."answerId" IS NOT NULL THEN 'answer'
      WHEN t."reviewId" IS NOT NULL THEN 'review'
      WHEN t."articleId" IS NOT NULL THEN 'article'
      WHEN t."bountyId" IS NOT NULL THEN 'bounty'
      WHEN t."bountyEntryId" IS NOT NULL THEN 'bountyEntry'
      WHEN t."challengeId" IS NOT NULL THEN 'challenge'
      WHEN t."model3dId" IS NOT NULL THEN 'model3d'
      ELSE 'comment'
      END,
      'username', u.username
      ) "details"
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      JOIN "User" u ON c."userId" = u.id
      LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
      LEFT JOIN "app_listings" al ON al."serial_id" = COALESCE(root."appListingId", t."appListingId")
      WHERE c."createdAt" > '2026-01-01T00:00:00.000Z'
      AND t."questionId" IS NULL
      AND t."answerId" IS NULL
      AND (COALESCE(root."appListingId", t."appListingId") IS NULL OR al.slug IS NOT NULL)
      )
      SELECT
      concat('new-thread-response:user:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId') "key",
      case
      when details->>'version' is null then concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId')
      when details->>'threadType' <> 'comment' then concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId')
      end "dedupeKey",
      "ownerId"    "userId",
      'new-thread-response' "type",
      details
      FROM new_thread_response r
      WHERE
      NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-thread-response')"
    `);
  });

  it('new-mention: whole statement', () => {
    expect(normalizeSql(queries['new-mention'])).toMatchInlineSnapshot(`
      "WITH new_mentions AS (
      SELECT DISTINCT
      CAST(unnest(regexp_matches(content, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
      c."userId" "actorId",
      JSONB_BUILD_OBJECT(
      'version', 2,
      'mentionedIn', 'comment',
      'commentId', c.id,
      'threadId', c."threadId",
      'threadParentId', COALESCE(
      root."imageId",
      root."modelId",
      root."postId",
      root."questionId",
      root."answerId",
      root."reviewId",
      root."articleId",
      root."bountyId",
      root."bountyEntryId",
      root."challengeId",
      root."model3dId",
      t."imageId",
      t."modelId",
      t."postId",
      t."questionId",
      t."answerId",
      t."reviewId",
      t."articleId",
      t."bountyId",
      t."bountyEntryId",
      t."challengeId",
      t."model3dId"
      ),
      'threadType', CASE
      WHEN COALESCE(root."imageId", t."imageId") IS NOT NULL THEN 'image'
      WHEN COALESCE(root."modelId", t."modelId") IS NOT NULL THEN 'model'
      WHEN COALESCE(root."postId", t."postId") IS NOT NULL THEN 'post'
      WHEN COALESCE(root."questionId", t."questionId") IS NOT NULL THEN 'question'
      WHEN COALESCE(root."answerId", t."answerId") IS NOT NULL THEN 'answer'
      WHEN COALESCE(root."reviewId", t."reviewId") IS NOT NULL THEN 'review'
      WHEN COALESCE(root."articleId", t."articleId") IS NOT NULL THEN 'article'
      WHEN COALESCE(root."bountyId", t."bountyId") IS NOT NULL THEN 'bounty'
      WHEN COALESCE(root."bountyEntryId", t."bountyEntryId") IS NOT NULL THEN 'bountyEntry'
      WHEN COALESCE(root."challengeId", t."challengeId") IS NOT NULL THEN 'challenge'
      WHEN COALESCE(root."model3dId", t."model3dId") IS NOT NULL THEN 'model3d'
      WHEN al.slug IS NOT NULL THEN 'appListing'
      ELSE 'comment'
      END,
      'appListingSlug', al.slug,
      'commentParentId', COALESCE(
      t."imageId",
      t."modelId",
      t."postId",
      t."questionId",
      t."answerId",
      t."reviewId",
      t."articleId",
      t."bountyId",
      t."bountyEntryId",
      t."challengeId",
      t."model3dId",
      t."commentId"
      ),
      'commentParentType', CASE
      WHEN t."imageId" IS NOT NULL THEN 'image'
      WHEN t."modelId" IS NOT NULL THEN 'model'
      WHEN t."postId" IS NOT NULL THEN 'post'
      WHEN t."questionId" IS NOT NULL THEN 'question'
      WHEN t."answerId" IS NOT NULL THEN 'answer'
      WHEN t."reviewId" IS NOT NULL THEN 'review'
      WHEN t."articleId" IS NOT NULL THEN 'article'
      WHEN t."bountyId" IS NOT NULL THEN 'bounty'
      WHEN t."bountyEntryId" IS NOT NULL THEN 'bountyEntry'
      WHEN t."challengeId" IS NOT NULL THEN 'challenge'
      WHEN t."model3dId" IS NOT NULL THEN 'model3d'
      ELSE 'comment'
      END,
      'username', u.username
      ) "details"
      FROM "CommentV2" c
      JOIN "User" u ON c."userId" = u.id
      JOIN "Thread" t ON t.id = c."threadId"
      LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
      LEFT JOIN "app_listings" al ON al."serial_id" = COALESCE(root."appListingId", t."appListingId")
      WHERE (c."createdAt" > '2026-01-01T00:00:00.000Z')
      AND c.content LIKE '%"mention:%'
      AND t."questionId" IS NULL
      AND t."answerId" IS NULL
      AND (COALESCE(root."appListingId", t."appListingId") IS NULL OR al.slug IS NOT NULL)
      UNION
      SELECT DISTINCT
      CAST(unnest(regexp_matches(content, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
      c."userId" "actorId",
      JSONB_BUILD_OBJECT(
      'mentionedIn', 'comment',
      'modelId', c."modelId",
      'commentId', c.id,
      'parentId', c."parentId",
      'parentType', CASE WHEN c."parentId" IS NOT NULL THEN 'comment' ELSE 'review' END,
      'modelName', m.name,
      'username', u.username
      ) "details"
      FROM "Comment" c
      JOIN "User" u ON c."userId" = u.id
      JOIN "Model" m ON m.id = c."modelId"
      WHERE m."userId" > 0
      AND (c."createdAt" > '2026-01-01T00:00:00.000Z')
      AND c.content LIKE '%"mention:%'
      UNION
      SELECT DISTINCT
      CAST(unnest(regexp_matches(m.description, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
      m."userId" "actorId",
      JSONB_BUILD_OBJECT(
      'mentionedIn', 'model',
      'modelId', m.id,
      'modelName', m.name,
      'username', u.username
      ) "details"
      FROM "Model" m
      JOIN "User" u ON m."userId" = u.id
      WHERE m."userId" > 0
      AND (m."publishedAt" > '2026-01-01T00:00:00.000Z' OR m."updatedAt" > '2026-01-01T00:00:00.000Z')
      AND m.description LIKE '%"mention:%'
      AND m.status = 'Published'
      )
      SELECT
      concat('new-mention:user:', case when details->>'mentionedIn' = 'model' then 'model:' when details->>'version' is not null then 'v2:' else 'v1:' end, coalesce(details->>'commentId', details->>'modelId')) "key",
      case
      when details->>'mentionedIn' <> 'comment' then null
      when details->>'version' is not null then
      case when details->>'threadType' <> 'comment' then concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId') end
      when details->>'parentType' = 'comment' then concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId')
      end "dedupeKey",
      "ownerId"    "userId",
      'new-mention' "type",
      details
      FROM new_mentions r
      WHERE
      NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-mention')
      AND NOT EXISTS (
      SELECT 1 FROM "UserEngagement" blk
      WHERE (blk."userId" = r."ownerId" AND blk."targetUserId" = r."actorId" AND blk.type IN ('Block', 'Hide'))
      OR (blk."userId" = r."actorId" AND blk."targetUserId" = r."ownerId" AND blk.type = 'Block')
      )"
    `);
  });
});
