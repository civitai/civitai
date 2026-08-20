import { describe, expect, it } from 'vitest';
import {
  APP_LISTING_OWNER_SQL,
  CommentNotificationPriority,
  commentNotifications,
} from '~/server/notifications/comment.notifications';
import { mentionNotifications } from '~/server/notifications/mention.notifications';
import { appListingNotifications } from '~/server/notifications/app-listing.notifications';
import { notBlockedBetween } from '~/server/notifications/base.notifications';
import { NotificationCategory } from '~/server/common/enums';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationProcessors,
  notificationTypes,
} from '~/server/notifications/utils.notifications';

/**
 * `new-app-listing-comment` — the app-listing owner's notification for a top-level comment.
 *
 * #4160 made app-listing threads notify for MENTIONS, REPLIES and THREAD RESPONSES. The residue it
 * deliberately left: a first top-level comment on a listing whose owner has never joined the thread
 * notified nobody, because the owner-facing processors are per-entity SQL and none of them had an
 * `appListing` branch. This is that branch, as its own notification type.
 *
 * What is asserted here, and why each shape:
 *   - the WHOLE resolved URL, never a substring. The destination is the owner's `/apps/mine`
 *     submissions view, NOT the public listing page: that page gates on `hasAppsStoreAccess`
 *     and, measured against prod, 404s for one of the four current listing owners.
 *   - the WHOLE normalised SQL statement via `toMatchInlineSnapshot`, because a fragment
 *     assertion is satisfied by semantically inverted SQL — an appended `AND 1 = 0`, an
 *     `OR TRUE` bolted onto the self-notify guard, or swapped `notBlockedBetween` arguments all
 *     leave every fragment intact. Fragments stay as well, for readable failures.
 *   - the SQL with COMMENTS STRIPPED FIRST, so a guard left in place as a comment (text present,
 *     clause dead) still fails.
 *   - the dedupe interaction with the three types #4160 enabled, since "must not double-notify"
 *     is the requirement that is easy to state and easy to get wrong.
 *   - the settings toggle via the OUTPUT of `getNotificationTypes` (`toggleable` is the real
 *     lever), never via `defaultDisabled` — a removed concept that can only read `undefined`.
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
  it('links to the owner submissions view (WHOLE url)', () => {
    expect(message()?.url).toBe('/apps/mine');
  });

  it('names the listing in the copy the owner reads', () => {
    expect(message()?.message).toBe(`${USERNAME} commented on your app listing: "${LISTING_NAME}"`);
  });

  it('🔴 does NOT deep-link to the public listing page, which 404s for most owners', () => {
    // The regression this guards is a measured one, not a hypothetical. `/apps/store-preview/<slug>`
    // gates on `hasAppsStoreAccess` (moderators OR app-dev-testers); of the 4 current listing
    // owners in prod, one is in NEITHER cohort, so the deep link 404s for the person being
    // notified. Asserted as a NEGATIVE because the failure mode is "someone helpfully makes the
    // link more specific" — which reads as an improvement in review.
    expect(message()?.url).not.toContain('/apps/store-preview');
    expect(message({ appListingSlug: 'anything' })?.url).toBe('/apps/mine');
  });

  it('shares the destination constant with the other owner-facing listing notifications', () => {
    // A RELATIONSHIP: a route rename must move all five together, so this compares against a
    // sibling processor's RENDERED url rather than against the string '/apps/mine'.
    //
    // 🔴 ON ITS OWN THIS ASSERTION IS TAUTOLOGICAL, and saying so is the point. Both sides read
    // the same `OWNER_SUBMISSIONS_URL`, so changing that constant to '/apps/other' drifts them
    // together and this test still passes (verified). What it proves is only "these two agree" —
    // never "they agree on the RIGHT value".
    //
    // The three literal `toBe('/apps/mine')` assertions above are what pin the value; this pins
    // that the sharing is real and not a coincidence of two matching literals. The PAIR is the
    // guard. Do not "simplify" either half away: drop the literals and a wrong route passes; drop
    // this and a duplicated literal drifts silently.
    const sibling = (appListingNotifications as unknown as Record<string, Def>)[
      'app-listing-approved'
    ].prepareMessage({
      type: 'app-listing-approved',
      details: { slug: SLUG, name: LISTING_NAME },
    });
    expect(message()?.url).toBe(sibling?.url);
    // Anchors the shared value, so this test cannot pass while both sides drift.
    expect(sibling?.url).toBe('/apps/mine');
  });

  it('the url is independent of the slug entirely (no slug-shaped failure modes left)', () => {
    // With a static destination there is no `/apps/store-preview/undefined` to render, so the
    // whole class of missing-slug broken links is gone rather than merely guarded.
    for (const appListingSlug of [undefined, null, '', 'a b/c']) {
      expect(message({ appListingSlug })?.url).toBe('/apps/mine');
    }
  });
});

describe('new-app-listing-comment — SQL: who it notifies, and who it must not', () => {
  it('notifies the listing OWNER, off the app_listings join', () => {
    const s = normalizeSql(sql());
    expect(s).toContain('JOIN "app_listings" al ON al."serial_id" = t."appListingId"');
    expect(s).toContain(`CASE WHEN al.kind = 'onsite'`);
  });

  it('🔴 resolves the owner KIND-AWARELY, not from the denormalized column alone', () => {
    // `app_listings.user_id` is a denormalized copy for onsite listings and can go stale; the
    // canonical owner is `AppBlock.app.userId`. A divergence would send the listing name, slug
    // and a commenter's username to the PREVIOUS owner and silently drop it for the real one —
    // a disclosure, not just a miss. Measured: 0 of 21 onsite listings diverge today, so this is
    // latent; 17 of 21 are the shape that could.
    const s = normalizeSql(sql());
    expect(s).toContain(
      `CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END`
    );
    expect(s).toContain('LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"');
    expect(s).toContain('LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"');
    // LEFT, not INNER: an offsite listing has no block and must still notify its owner.
    expect(s).not.toMatch(/(?<!LEFT )JOIN "app_blocks"/);
  });

  it('🔴 only APPROVED listings notify — the destination is approved-only', () => {
    // `appListings.getAppDetail` is approved-only, so a comment on a draft / rejected /
    // moderator-REMOVED listing notifies its owner toward a NotFound. Prod: only 14 of 28
    // listings are approved, so this is half the population, not an edge case.
    expect(normalizeSql(sql())).toContain(`al."status" = 'approved'`);
  });

  it('never notifies off a shadow revision, which can name a stale owner', () => {
    expect(normalizeSql(sql())).toContain(`al."revision_of_id" IS NULL`);
  });

  it('NEGATIVE CONTROL: a commenter never notifies themselves', () => {
    // Without this the owner is notified for their own comment on their own listing. Compared
    // against the RESOLVED owner expression, not the raw column — the guard must exclude the
    // canonical owner, which for an onsite listing is not `al."user_id"`.
    expect(normalizeSql(sql())).toContain(`c."userId" != ${APP_LISTING_OWNER_SQL}`);
  });

  it('skips system-owned listings', () => {
    expect(normalizeSql(sql())).toContain(`${APP_LISTING_OWNER_SQL} > 0`);
  });

  it('keeps the top-level predicate, which is REDUNDANT defence-in-depth rather than the guard', () => {
    // 🔴 CLAIM CORRECTED. This test used to say that dropping the `IS NOT NULL` "would match reply
    // threads too, and every reply would notify the owner a second time". That is FALSE, and
    // asserting it made the test name overclaim what the predicate does.
    //
    // What actually excludes replies is the INNER `JOIN "app_listings" al ON al."serial_id" =
    // t."appListingId"` — NULL never equals anything, so a reply thread is dropped by the join
    // whether or not this predicate exists. Deleting it yields BYTE-IDENTICAL rows.
    //
    // So the deletion mutant SURVIVES as UNREACHABLE, not as unasserted — no input can make it
    // change the answer, and the two diagnoses have opposite remedies (an unasserted mutant wants
    // an assertion; an unreachable one wants none, because any test for it is vacuous by
    // construction). This assertion therefore pins the predicate's PRESENCE as intent that must
    // survive a refactor making the join LEFT or reordering it — not its behaviour.
    //
    // Provenance: the byte-identical result was measured by the #4184 audit against a real
    // Postgres 16 fixture built from the repo's DDL. Recorded rather than re-derived.
    expect(normalizeSql(sql())).toContain(
      'JOIN "Thread" t ON t.id = c."threadId" AND t."appListingId" IS NOT NULL'
    );
    // The clause that does the real work, pinned beside it so the pair cannot drift apart.
    expect(normalizeSql(sql())).toContain(
      'JOIN "app_listings" al ON al."serial_id" = t."appListingId"'
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

  it('🔴 WHOLE STATEMENT — a fragment assertion is satisfied by semantically inverted SQL', () => {
    // Every other check in this describe pins a FRAGMENT, and fragments are walkable. A 23-mutant
    // battery found three semantic mutants that passed the entire 295-test suite:
    //   • `AND 1 = 0` appended  → 7 rows becomes 0. The feature is dead, permanently, silently.
    //   • `AND (c."userId" != <owner> OR TRUE)` → the self-notify guard is present AND inert.
    //   • notBlockedBetween arguments swapped → the wrong person's Hide is honoured.
    // Each leaves every fragment intact, so only the whole normalised statement can see them.
    // Same instrument the sibling file uses for the three #4160 processors.
    expect(normalizeSql(sql())).toMatchInlineSnapshot(`
      "WITH new_app_listing_comment AS (
      SELECT DISTINCT
      CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END "ownerId",
      JSONB_BUILD_OBJECT(
      'version', 2,
      'commentId', c.id,
      'appListingSlug', al.slug,
      'listingName', al.name,
      'username', u.username
      ) "details"
      FROM "CommentV2" c
      JOIN "User" u ON c."userId" = u.id
      JOIN "Thread" t ON t.id = c."threadId" AND t."appListingId" IS NOT NULL
      JOIN "app_listings" al ON al."serial_id" = t."appListingId"
      LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"
      LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"
      WHERE CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END > 0
      AND al."status" = 'approved'
      AND al."revision_of_id" IS NULL
      AND c."createdAt" > '2026-01-01T00:00:00.000Z'
      AND c."createdAt" > '2026-08-19'
      AND c."createdAt" > NOW() - INTERVAL '7 days'
      AND c."userId" != CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END
      AND NOT EXISTS (
      SELECT 1 FROM "UserEngagement" blk
      WHERE (blk."userId" = CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END AND blk."targetUserId" = c."userId" AND blk.type IN ('Block', 'Hide'))
      OR (blk."userId" = c."userId" AND blk."targetUserId" = CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END AND blk.type = 'Block')
      )
      )
      SELECT
      concat('new-comment-app-listing:owner:v2:', details->>'commentId') "key",
      concat('comment:v2:', details->>'commentId') "dedupeKey",
      "ownerId"    "userId",
      'new-app-listing-comment' "type",
      details
      FROM new_app_listing_comment
      WHERE
      NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-app-listing-comment');"
    `);
  });

  it('honors the per-user opt-out row, under its own type name', () => {
    expect(normalizeSql(sql())).toContain(
      `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = '${TYPE}')`
    );
  });

  it('respects the block list, with the recipient/actor arguments in the RIGHT ORDER', () => {
    // 🔴 `notBlockedBetween(recipient, actor)` is asymmetric: the recipient's `Hide` suppresses,
    // the actor's does not. Swapping the two arguments produces valid SQL that inverts who gets
    // muted, and a `toMatch(/UserEngagement/)` check is satisfied by both orders — which is
    // exactly how that mutant walked. Pin the generated clause against the helper called with
    // the intended arguments, so the assertion cannot agree with the swap.
    expect(normalizeSql(sql())).toContain(
      normalizeSql(notBlockedBetween(APP_LISTING_OWNER_SQL, 'c."userId"'))
    );
    // Positive control: the helper really is order-sensitive, so the equality above is a fact
    // about argument order rather than about a symmetric string.
    expect(normalizeSql(notBlockedBetween(APP_LISTING_OWNER_SQL, 'c."userId"'))).not.toBe(
      normalizeSql(notBlockedBetween('c."userId"', APP_LISTING_OWNER_SQL))
    );
    expect(normalizeSql(sql())).not.toContain(
      normalizeSql(notBlockedBetween('c."userId"', APP_LISTING_OWNER_SQL))
    );
  });

  it('advances with the per-key cursor and is floored against a backlog flood', () => {
    const s = normalizeSql(sql());
    expect(s).toContain(`AND c."createdAt" > '${LAST_SENT}'`);
    expect(s).toContain(`AND c."createdAt" > NOW() - INTERVAL '7 days'`);

    // The launch floor is EXTRACTED from the generated SQL, not restated as a literal. A
    // duplicated constant makes this check unfalsifiable: move the floor into the future and a
    // hardcoded `new Date('2026-08-19')` still passes while the processor is disabled forever.
    const floors = [...s.matchAll(/AND c\."createdAt" > '(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
    expect(floors, 'no literal-date floor found in the generated SQL').toHaveLength(1);
    expect(new Date(floors[0]!).getTime()).toBeLessThan(Date.now());
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
  });

  it('🔴 actually RENDERS in the settings list — the lever is `toggleable`, not a field name', () => {
    // This replaces an assertion on `defaultDisabled`, which is a REMOVED concept: it can only
    // ever read `undefined`, so `.toBeFalsy()` passed vacuously and proved nothing.
    // (`notification-settings-polarity.test.ts` actively asserts no source contains that field.)
    //
    // The lever that decides whether the toggle renders is `toggleable` — `getNotificationTypes`
    // skips `toggleable === false && !showCategory`. A `toggleable: false` mutant made the type
    // vanish from BOTH the settings UI and the bulk-toggle list while all 295 tests stayed green.
    // Assert the OUTPUT of that function rather than an input field.
    const commentTypes = notificationCategoryTypes[NotificationCategory.Comment] ?? [];
    expect(commentTypes.map((t) => t.type)).toContain(TYPE);
    // It is a plain opt-OUT type: it must be in the bulk-toggle list, not the opt-in list.
    expect(notificationTypes).toContain(TYPE);
    expect(isOptInNotification(TYPE)).toBe(false);
  });

  it('positive control: that list can distinguish membership (a bogus type is absent)', () => {
    // Guards the assertion above against a `toContain` on an array that holds everything.
    const commentTypes = notificationCategoryTypes[NotificationCategory.Comment] ?? [];
    expect(commentTypes.map((t) => t.type)).not.toContain('new-app-listing-comment-nope');
  });

  it('is labeled for app listings in that settings list', () => {
    expect(commentDefs[TYPE].displayName).toBe('New comments on your app listings');
  });
});

/**
 * 🔴 INVARIANT GUARDS, not regression coverage of THIS change.
 *
 * This PR touches none of these processors — it only adds a new one alongside them. These pin
 * behaviour #4160 shipped and this change must not disturb, which is a real thing to hold, but
 * calling it "regression coverage" would overclaim: they are green at the base commit and stay
 * green, so they cannot demonstrate that anything here works.
 */
describe('INVARIANT GUARD: the reply/mention behaviour #4160 shipped is unchanged', () => {
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

  it('INVARIANT GUARD: the other entity-owner processors are untouched', () => {
    for (const type of ['new-post-comment', 'new-image-comment', 'new-article-comment']) {
      expect(commentDefs[type].priority).toBe(CommentNotificationPriority.EntityOwner);
    }
  });
});
