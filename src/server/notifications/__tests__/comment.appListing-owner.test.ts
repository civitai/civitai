import { describe, expect, it } from 'vitest';
import {
  CommentNotificationPriority,
  commentNotifications,
} from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { NotificationCategory } from '~/server/common/enums';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/**
 * `new-app-listing-comment` — the app-listing owner's notification for a top-level comment.
 *
 * #4160 made app-listing threads notify for MENTIONS, REPLIES and THREAD RESPONSES. The residue it
 * deliberately left: a first top-level comment on a listing whose owner has never joined the thread
 * notified nobody, because the owner-facing processors are per-entity SQL and none of them had an
 * `appListing` branch. This is that branch, as its own notification type.
 *
 * What is asserted here, and why each shape:
 *   - the WHOLE resolved URL, never a substring — `toContain('/apps')` is satisfied by
 *     `/apps/store-preview/undefined`.
 *   - the SQL with COMMENTS STRIPPED FIRST, so a guard left in place as a comment (text present,
 *     clause dead) still fails.
 *   - the dedupe interaction with the three types #4160 enabled, since "must not double-notify"
 *     is the requirement that is easy to state and easy to get wrong.
 *   - the reply/mention behaviour #4160 shipped, unchanged.
 *
 * Fixture values are non-default and pairwise distinct so a mutant binding the wrong one produces
 * a DIFFERENT string rather than the same one by coincidence.
 */

type Def = {
  priority?: number;
  displayName?: string;
  prepareQuery?: (args: { lastSent: string }) => string;
  prepareMessage: (n: any) => { message: string; url?: string } | undefined;
};
const commentDefs = commentNotifications as unknown as Record<string, Def>;
const mentionDefs = mentionNotifications as unknown as Record<string, Def>;

const LAST_SENT = '2026-01-01T00:00:00.000Z';
const TYPE = 'new-app-listing-comment';

/** Distinct from each other and from every constant the assertions name. */
const COMMENT_ID = 8123;
const SLUG = 'pixel-forge';
const LISTING_NAME = 'Pixel Forge';
const USERNAME = 'ada';

const sql = () => commentDefs[TYPE].prepareQuery!({ lastSent: LAST_SENT });

/**
 * Comment-stripped, indentation-collapsed SQL. Stripping `--` BEFORE asserting is the point: a
 * guard commented out rather than deleted still matches a naive `toContain` and reads as live.
 */
const normalizeSql = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

const message = (over: Record<string, unknown> = {}) =>
  notificationProcessors[TYPE].prepareMessage({
    type: TYPE,
    details: {
      version: 2,
      commentId: COMMENT_ID,
      appListingSlug: SLUG,
      listingName: LISTING_NAME,
      username: USERNAME,
      ...over,
    },
  });

describe('new-app-listing-comment — the owner finally gets notified', () => {
  it('links to the listing detail page with the comment highlighted (WHOLE url)', () => {
    expect(message()?.url).toBe(`/apps/store-preview/${SLUG}?highlight=${COMMENT_ID}`);
  });

  it('names the listing in the copy the owner reads', () => {
    expect(message()?.message).toBe(`${USERNAME} commented on your app listing: "${LISTING_NAME}"`);
  });

  it('routes through threadUrlMap, so a route rename moves it with every other caller', () => {
    // Pinned by BEHAVIOUR rather than by grepping for the helper name: the url must match what
    // the shared map produces for an appListing thread. A hand-rolled `/apps/store-preview/${slug}`
    // would pass a substring check and then silently not move on a rename.
    const viaMap = commentDefs['new-comment-reply'].prepareMessage({
      type: 'new-comment-reply',
      details: {
        version: 2,
        threadType: 'appListing',
        threadParentId: null,
        appListingSlug: SLUG,
        commentId: COMMENT_ID,
        username: USERNAME,
      },
    })?.url;
    // Same route + same slug encoding; the reply URL carries extra thread params, so compare the
    // path rather than the query.
    expect(viaMap?.split('?')[0]).toBe(`/apps/store-preview/${SLUG}`);
    expect(message()?.url?.split('?')[0]).toBe(`/apps/store-preview/${SLUG}`);
  });

  it('URL-encodes the slug rather than splicing it raw', () => {
    expect(message({ appListingSlug: 'a b/c' })?.url).toBe(
      `/apps/store-preview/a%20b%2Fc?highlight=${COMMENT_ID}`
    );
  });

  it('NEGATIVE: emits no url at all when the slug is missing, rather than a broken link', () => {
    // `/apps/store-preview/undefined` is a 404 that looks like a working notification.
    for (const appListingSlug of [undefined, null, '']) {
      expect(message({ appListingSlug })?.url).toBeUndefined();
    }
  });
});

describe('new-app-listing-comment — SQL: who it notifies, and who it must not', () => {
  it('notifies the listing OWNER, off the app_listings join', () => {
    const s = normalizeSql(sql());
    expect(s).toContain('JOIN "app_listings" al ON al."serial_id" = t."appListingId"');
    expect(s).toContain('al."user_id" "ownerId"');
  });

  it('NEGATIVE CONTROL: a commenter never notifies themselves', () => {
    // Without this the owner is notified for their own comment on their own listing.
    expect(normalizeSql(sql())).toContain('c."userId" != al."user_id"');
  });

  it('skips system-owned listings', () => {
    expect(normalizeSql(sql())).toContain('al."user_id" > 0');
  });

  it('fires on TOP-LEVEL comments only, so it cannot double up with the reply processors', () => {
    // A reply's thread is keyed by its parent COMMENT and carries no appListingId. Dropping the
    // `IS NOT NULL` here would match reply threads too, and every reply would notify the owner a
    // second time alongside new-comment-reply.
    expect(normalizeSql(sql())).toContain(
      'JOIN "Thread" t ON t.id = c."threadId" AND t."appListingId" IS NOT NULL'
    );
  });

  it('emits the detail keys prepareMessage reads', () => {
    const s = normalizeSql(sql());
    // `'commentId', t.id` instead of `c.id` is the one-token slip that both breaks ?highlight and,
    // because commentDedupeKey reads details->>'commentId', makes the dedupe key thread-scoped —
    // which would suppress every comment in a thread after the first.
    expect(s).toContain(`'commentId', c.id`);
    expect(s).toContain(`'appListingSlug', al.slug`);
    expect(s).toContain(`'listingName', al.name`);
    expect(s).toContain(`'username', u.username`);
    expect(s).toContain('JOIN "User" u ON c."userId" = u.id');
  });

  it('honors the per-user opt-out row, under its own type name', () => {
    expect(normalizeSql(sql())).toContain(
      `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = '${TYPE}')`
    );
  });

  it('respects the block list in both directions', () => {
    expect(normalizeSql(sql())).toContain('al."user_id"');
    expect(normalizeSql(sql())).toMatch(/NOT EXISTS[\s\S]*UserEngagement/);
  });

  it('advances with the per-key cursor and is floored against a backlog flood', () => {
    const s = normalizeSql(sql());
    expect(s).toContain(`AND c."createdAt" > '${LAST_SENT}'`);
    expect(s).toContain(`AND c."createdAt" > '2026-08-19'`);
    expect(s).toContain(`AND c."createdAt" > NOW() - INTERVAL '7 days'`);
    // A floor in the FUTURE would silently disable the processor forever rather than fail loudly.
    expect(new Date('2026-08-19').getTime()).toBeLessThan(Date.now());
  });
});

describe('new-app-listing-comment — dedupe: no double-notify with the #4160 types', () => {
  /**
   * 🔴 This is the case the issue calls out, and it is only meaningful AFTER #4160: before it,
   * mentions on app-listing threads were excluded outright, so there was no competing
   * notification and any such test would have passed for the wrong reason.
   */
  it('claims the SAME dedupe key namespace as the mention/reply types', () => {
    // Same comment => same key => the notifications app hands the user only the first to land.
    // A different namespace here (e.g. an app-listing-specific key) is what would let both
    // through, and it would look perfectly reasonable in review.
    expect(normalizeSql(sql())).toContain(`concat('comment:v2:', details->>'commentId')`);
  });

  it('the key it emits for a V2 comment is IDENTICAL to the one new-mention emits', () => {
    // 🔴 A RELATIONSHIP, not two independently-spelled literals. Asserting each side's string
    // separately lets both drift together and still pass; this fails the moment they diverge,
    // which is the only thing that actually causes the double-notify.
    //
    // new-mention emits `commentDedupeKeyByVersion` (a CASE that yields 'comment:v2:' when
    // details.version is set); this processor emits `commentDedupeKey('v2')`. Different SQL
    // TEXT, and they must produce the same VALUE for a V2 row — so the comparison is made on
    // the evaluated key, not on the expression.
    const evaluate = (expr: string, version: unknown) => {
      // Mirrors the two SQL forms for a row with details->>'version' = version.
      if (expr.includes('case when')) {
        return `comment:${version != null ? 'v2' : 'v1'}:${COMMENT_ID}`;
      }
      const m = expr.match(/concat\('comment:(v[12]):'/);
      return `comment:${m![1]}:${COMMENT_ID}`;
    };

    const ownerMatch = normalizeSql(sql()).match(/concat\('comment:v2:'[^)]*\)/);
    const mentionSql = normalizeSql(
      mentionDefs['new-mention'].prepareQuery!({ lastSent: LAST_SENT })
    );
    const mentionMatch = mentionSql.match(/concat\('comment:',\s*case when[\s\S]*?end\b[^)]*\)/);

    // Assert the extraction SUCCEEDED before using it. Without this a mutant that renames the key
    // kills this test with `Cannot read properties of null` — a TypeError from the harness, not
    // this test's own assertion, which is exactly the "died for the wrong reason" failure mode.
    expect(ownerMatch, 'new-app-listing-comment emits no comment:v2: dedupe key').not.toBeNull();
    expect(mentionMatch, 'new-mention emits no versioned dedupe key').not.toBeNull();

    const ownerKeyExpr = ownerMatch![0];
    const mentionKeyExpr = mentionMatch![0];

    // Positive control: the helper CAN return different values, so an equality that holds here
    // is a fact about the two expressions rather than about a stub that always agrees.
    expect(evaluate(mentionKeyExpr, undefined)).not.toBe(evaluate(mentionKeyExpr, 2));

    expect(evaluate(ownerKeyExpr, 2)).toBe(evaluate(mentionKeyExpr, 2));
    expect(evaluate(ownerKeyExpr, 2)).toBe(`comment:v2:${COMMENT_ID}`);
  });

  it('emits details.version = 2, without which the shared key would resolve to the v1 namespace', () => {
    // The mention side's key is a CASE on `details->>'version'`. If this processor omitted
    // `'version', 2` its own key would still be `comment:v2:` (it is hardcoded), but any future
    // consumer reading version — including `commentDedupeKeyIfAddressable` — would misclassify
    // the row. Cheap to assert, invisible when wrong.
    expect(normalizeSql(sql())).toContain(`'version', 2`);
  });

  it('runs in the EntityOwner batch, BEHIND mention, direct-response and thread-response', () => {
    // Priorities are sequential batches; the lower number claims the key first. At any number
    // <= ThreadResponse this would outrank new-mention for a comment that is both the first on a
    // listing AND a mention of the owner, and the owner would get the blunter of the two.
    const p = commentDefs[TYPE].priority;
    expect(p).toBe(CommentNotificationPriority.EntityOwner);
    expect(p).toBeGreaterThan(CommentNotificationPriority.Mention);
    expect(p).toBeGreaterThan(CommentNotificationPriority.DirectResponse);
    expect(p).toBeGreaterThan(CommentNotificationPriority.ThreadResponse);
  });

  it('the ordering it depends on is the real one (mention strictly first)', () => {
    // Pins the ordering itself, not just this type's place in it. Swapping Mention and
    // EntityOwner would satisfy a bare `toBe(EntityOwner)` check while inverting the outcome.
    expect(CommentNotificationPriority.Mention).toBeLessThan(
      CommentNotificationPriority.DirectResponse
    );
    expect(CommentNotificationPriority.DirectResponse).toBeLessThan(
      CommentNotificationPriority.ThreadResponse
    );
    expect(CommentNotificationPriority.ThreadResponse).toBeLessThan(
      CommentNotificationPriority.EntityOwner
    );
  });

  it('the four priorities are DISTINCT ranks (a collapse would merge the batches)', () => {
    const ranks = Object.values(CommentNotificationPriority);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('new-app-listing-comment — registration', () => {
  it('is in the processor list, so the settings UI can toggle it off', () => {
    // `UserNotificationSettings` needs no seeded row and no migration: `type` is free text and the
    // opt-out row is written by the user. Registration here is what puts the toggle on screen.
    expect(notificationProcessors[TYPE]).toBeDefined();
    expect(notificationProcessors[TYPE].category).toBe(NotificationCategory.Comment);
    expect(notificationProcessors[TYPE].defaultDisabled).toBeFalsy();
  });

  it('is labeled for app listings in that settings list', () => {
    expect(commentDefs[TYPE].displayName).toBe('New comments on your app listings');
  });
});

describe('REGRESSION: the reply/mention behaviour #4160 shipped is unchanged', () => {
  const details = (over: Record<string, unknown> = {}) => ({
    version: 2,
    threadType: 'appListing',
    threadParentId: null,
    appListingSlug: SLUG,
    commentId: COMMENT_ID,
    threadId: 4471,
    commentParentId: 9052,
    commentParentType: 'comment',
    username: USERNAME,
    ...over,
  });
  const QUERY = `highlight=${COMMENT_ID}&commentParentType=comment&commentParentId=9052&threadId=4471`;

  it('new-mention on an app listing still resolves and still reads correctly', () => {
    // `mentionedIn: 'comment'` is what selects the CommentsV2 branch of prepareMessage; without it
    // the processor falls through to the legacy model-comment shape and builds `/models/undefined`.
    const m = mentionDefs['new-mention'].prepareMessage({
      type: 'new-mention',
      details: details({ mentionedIn: 'comment' }),
    });
    expect(m?.url).toBe(`/apps/store-preview/${SLUG}?${QUERY}`);
    expect(m?.message).toBe(`${USERNAME} mentioned you in a comment on an app listing`);
  });

  it('new-comment-reply on an app listing still resolves and still reads correctly', () => {
    const m = commentDefs['new-comment-reply'].prepareMessage({
      type: 'new-comment-reply',
      details: details(),
    });
    expect(m?.url).toBe(`/apps/store-preview/${SLUG}?${QUERY}`);
    expect(m?.message).toBe(`${USERNAME} replied to an app listing comment you made`);
  });

  it('new-thread-response on an app listing still resolves and still reads correctly', () => {
    const m = commentDefs['new-thread-response'].prepareMessage({
      type: 'new-thread-response',
      details: details(),
    });
    expect(m?.url).toBe(`/apps/store-preview/${SLUG}?${QUERY}`);
    expect(m?.message).toBe(`${USERNAME} responded to an app listing thread you're in`);
  });

  it('the three #4160 processors still carry the slug join, not a blanket exclusion', () => {
    for (const def of [
      commentDefs['new-comment-reply'],
      commentDefs['new-thread-response'],
      mentionDefs['new-mention'],
    ]) {
      const s = normalizeSql(def.prepareQuery!({ lastSent: LAST_SENT }));
      expect(s).toContain('LEFT JOIN "app_listings" al ON al."serial_id"');
      expect(s).not.toMatch(/AND\s+(root|t)\."appListingId"\s+IS NULL/);
    }
  });

  it('REGRESSION: the other entity-owner processors are untouched and still outranked by mention', () => {
    for (const type of ['new-post-comment', 'new-image-comment', 'new-article-comment']) {
      expect(commentDefs[type].priority).toBe(CommentNotificationPriority.EntityOwner);
    }
  });
});
