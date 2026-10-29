import { constants } from '~/server/common/constants';
import { isEmpty } from 'lodash-es';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
  notCommentMuted,
} from '~/server/notifications/base.notifications';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { OWNER_SUBMISSIONS_URL } from '~/server/notifications/app-listing.notifications';
import { getModelCommentThreadUrl } from '~/utils/comment-url-helpers';
import { QS } from '~/utils/qs';
import { withDefiniteArticle } from '~/utils/string-helpers';

/**
 * A live CommentV3 row written since the cursor. Tombstones keep their row and must not notify, and
 * neither does a row hidden for ToS.
 */
export const liveV3Since = (lastSent: string) =>
  `c."deletedAt" IS NULL AND NOT c."tosViolation" AND c."createdAt" > '${lastSent}'`;

/**
 * The id the model page's dialog addresses a comment by: its old Comment id. Every v1-shaped row has
 * one; a row from the shared sequence carries its own id there.
 */
export const legacyId = (alias: string) => `${alias}."legacyV1Id"`;

/**
 * A comment the model page's v1 dialog can open: on a model, with an old `Comment` id. v2 comments
 * on model threads have none and stay thread-addressed.
 */
export const isV1Shaped = (alias: string) =>
  `(${alias}."entityType" = 'model' AND ${alias}."legacyV1Id" IS NOT NULL)`;

/** The comment a reply answers: the depth clamp keeps it in `replyToId` when it is not the parent. */
export const answeredId = (alias: string) => `COALESCE(${alias}."replyToId", ${alias}."parentId")`;

/**
 * The comment whose replies a notification opens. A v3 section lists a comment's direct replies,
 * where a clamped reply hangs off its parent; a v2 section opens the answered comment's thread.
 */
export const deepLinkParentId = (alias: string) =>
  `CASE WHEN ${alias}."entityType"::text = ANY(ARRAY[${constants.comments.v3ReadSurfaces
    .map((t) => `'${t}'`)
    .join(', ')}])
     THEN ${alias}."parentId" ELSE ${answeredId(alias)} END`;

/**
 * The two entities whose URL is not built from `entityId`: a comic chapter is addressed by its
 * project, and an app listing by its slug (`entityId` is `app_listings.serial_id`, which appears
 * nowhere in the URL). LEFT joins, paired with `v3AppListingResolved`: an app-listing comment whose
 * listing does not resolve is dropped rather than emitted with a `/apps/store-preview/undefined` link.
 */
export const v3EntityJoins = (alias: string) =>
  `LEFT JOIN "ComicChapter" cch ON ${alias}."entityType" = 'comicChapter' AND cch.id = ${alias}."entityId"
        LEFT JOIN "app_listings" al ON ${alias}."entityType" = 'appListing' AND al."serial_id" = ${alias}."entityId"`;

export const v3AppListingResolved = (alias: string) =>
  `(${alias}."entityType" <> 'appListing' OR al.slug IS NOT NULL)`;

/**
 * `threadType` is the key `threadUrlMap` addresses: the entity type, with a comic chapter folded into
 * its project and anything the map cannot address (a 3D model review) falling back to `'comment'`,
 * which `commentDedupeKeyIfAddressable` reads as "do not claim". Needs `v3EntityJoins`.
 */
export const v3ThreadType = (alias: string) => `CASE ${alias}."entityType"::text
                WHEN 'comicChapter' THEN 'comicProject'
                WHEN 'appListing' THEN CASE WHEN al.slug IS NOT NULL THEN 'appListing' ELSE 'comment' END
                WHEN 'model3dReview' THEN 'comment'
                ELSE ${alias}."entityType"::text
              END`;

export const v3ThreadParentId = (alias: string) =>
  `CASE ${alias}."entityType" WHEN 'comicChapter' THEN cch."projectId" ELSE ${alias}."entityId" END`;

/**
 * The details a thread-addressed notification carries; `extra` is more `'key', value,` pairs.
 * `commentParent*` is what lets the page open the conversation the comment is in: a reply names that
 * conversation's comment (`deepLinkParentId`), a top-level comment its entity.
 */
export const v3ThreadDetails = (extra: string) => `JSONB_BUILD_OBJECT(
            'version', 3,
            'commentId', c.id,
            'threadParentId', ${v3ThreadParentId('c')},
            'threadType', ${v3ThreadType('c')},
            'appListingSlug', al.slug,
            'commentParentId', COALESCE(${deepLinkParentId('c')}, ${v3ThreadParentId('c')}),
            'commentParentType', CASE WHEN c."parentId" IS NULL THEN ${v3ThreadType(
              'c'
            )} ELSE 'comment' END,
            ${extra}
            'username', u.username
          )`;

/**
 * The canonical owner of an app listing, in SQL — the raw-SQL mirror of
 * `resolveCanonicalListingOwner` in `~/server/services/blocks/app-access.service`.
 *
 * 🔴 OWNERSHIP IS NOT ONE COLUMN. It depends on the listing's KIND:
 *   - `onsite`  → the owner is `OauthClient.userId`, reached as `AppBlock.app.userId`.
 *                 `app_listings.user_id` is a DENORMALIZED COPY there and can go stale —
 *                 `acceptTransfer` calls it "the denormalized follow-up, where a 0-count is a
 *                 legitimate desync". It stays the FALLBACK, because a listing whose block
 *                 carries a dangling `app_id` still needs an owner.
 *   - anything else (incl. `offsite`) → the column IS the owner, unconditionally. An unknown
 *                 kind falls through to the column deliberately, matching the service's
 *                 fail-closed behaviour.
 *
 * Reading the column alone is latent-wrong rather than wrong today (measured: 0 of 21 onsite
 * listings diverge), but 17 of 21 onsite listings are the shape that could — and a divergence
 * would send the listing name, slug and a commenter's username to the PREVIOUS owner while the
 * real one silently got nothing. That is a disclosure, not just a miss, so it is resolved here
 * rather than commented around.
 *
 * Requires `al`, plus `LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"` and
 * `LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"` to be in scope.
 */
export const APP_LISTING_OWNER_SQL = `CASE WHEN al.kind = 'onsite' THEN COALESCE(oc."userId", al."user_id") ELSE al."user_id" END`;

/**
 * Human-readable noun for a thread type in notification copy.
 *
 * `threadType` is an entity KEY. Most read as English by accident of naming; the three that do
 * not are listed here, because a user should never be shown an identifier.
 *
 * `model3d` is a REORDERING, not just a spacing fix — "3D model", matching what the owner-facing
 * `new-3d-model-comment` copy already calls it, so the same thing has one name across the whole
 * notification family. It is also the one label whose first character is a DIGIT; the article is
 * chosen from the noun by `withIndefiniteArticle`, so "a 3D model" falls out rather than being
 * special-cased, and the test table pins it.
 *
 * ONE map, read by every consumer that names a thread in a sentence (`new-mention`,
 * `new-comment-reply`, `new-thread-response`), so the same thread is called the same thing
 * wherever the user meets it. It used to live at one call site only, which is exactly how two
 * of the three shipped the raw key.
 *
 * 🔴 A `Map`, not an object literal, and that is a correctness choice rather than a style one.
 * An object-literal lookup answers for keys it never declared — `labels['toString']` is a
 * truthy Function, which `??` does not catch — so a `threadType` of `toString`/`constructor`
 * would put a function body in a user-facing sentence. `Map.get` only ever returns what was
 * `set`. (`threadUrlMap` below has the same object-literal shape and the same latent hazard;
 * pre-existing and out of scope here, but do not copy it.)
 */
const THREAD_TYPE_LABELS = new Map<string, string>([
  ['appListing', 'app listing'],
  ['bountyEntry', 'bounty entry'],
  ['comicProject', 'comic'],
  ['model3d', '3D model'],
]);

export const threadTypeLabel = (threadType: string): string =>
  THREAD_TYPE_LABELS.get(threadType) ?? threadType;

/**
 * `"an app listing"` / `"a model"` — a noun with its indefinite article.
 *
 * 🔴 It takes the NOUN, never a thread type, and that signature is the guard rather than a
 * style choice. The article must agree with the word actually printed, and the way to
 * guarantee that is to leave the article-picker nothing else to read: no `threadType` is in
 * scope here, so "article derived from the raw entity key" is not expressible.
 *
 * The previous shape — a label computed at the call site with `label[0]` tested beside it —
 * left that mutation available and *unkillable*: rebinding it to `threadType[0]` changed no
 * output, because every reachable thread type and its label start with letters of the same
 * vowel-ness. Composing the two functions removes the expression instead of testing it.
 */
export const withIndefiniteArticle = (noun: string): string =>
  `${['a', 'e', 'i', 'o', 'u'].includes(noun[0]) ? 'an' : 'a'} ${noun}`;

/** The noun a thread is called in copy, article included: `"an app listing"`, `"a model"`. */
export const threadTypeWithArticle = (threadType: string): string =>
  withIndefiniteArticle(threadTypeLabel(threadType));

export const threadUrlMap = ({ threadType, threadParentId, ...details }: any) => {
  const queryString = QS.stringify({
    highlight: details.commentId,
    commentParentType: details.commentParentType,
    commentParentId: details.commentParentId,
    threadId: details.threadId,
  });

  return {
    model: `/models/${threadParentId}?dialog=commentThread&${queryString}`,
    image: `/images/${threadParentId}?${queryString}`,
    post: `/posts/${threadParentId}?${queryString}`,
    article: `/articles/${threadParentId}?${queryString}`,
    review: `/reviews/${threadParentId}?${queryString}`,
    bounty: `/bounties/${threadParentId}?${queryString}`,
    bountyEntry: `/bounties/entries/${threadParentId}?${queryString}`,
    challenge: `/challenges/${threadParentId}?${queryString}`,
    crucible: `/crucibles/${threadParentId}?${queryString}`,
    storyline: `${storylineUrl(threadParentId)}?${queryString}`,
    comicChapter: `/comics/${threadParentId}?${queryString}`,
    comicProject: `/comics/${threadParentId}?${queryString}`,
    model3d: `/3d-models/${threadParentId}?${queryString}`,
    // The one SLUG-addressed entry — see `v3EntityJoins`. `threadParentId` is NOT the
    // address here (it is `app_listings.serial_id`, which the URL never contains), so this
    // branch reads `details.appListingSlug` instead and shares `getListingDetailHref` with
    // the store cards so a route rename cannot move one without the other.
    //
    // No slug ⇒ `undefined`, i.e. the same "unaddressable" outcome an unknown threadType
    // gets. A missing slug must never render as `/apps/store-preview/undefined`, and
    // `undefined` here also leaves `commentDedupeKeyIfAddressable` free for a purpose-built
    // notification, exactly as the `'comment'` fallback does.
    appListing: details.appListingSlug
      ? `${getListingDetailHref(details.appListingSlug)}?${queryString}`
      : undefined,
    // question: `/questions/${threadParentId}?highlight=${details.commentId}#comments`,
    // answer: `/questions/${threadParentId}?highlight=${details.commentId}#answer-`,
  }[threadType as string] as string;
};

/**
 * SQL for the `dedupeKey` column every comment-derived processor selects. One comment can satisfy
 * several types at once (an @mention that is also a thread reply on a model you own); they all emit the
 * same dedupe key, and the notifications app hands the recipient only the first one to land. `v1` is a
 * model-page comment, `v2` every other surface; keys already written used overlapping ids, so the
 * namespace is load-bearing.
 */
export const commentDedupeKey = (version: 'v1' | 'v2') =>
  `concat('comment:${version}:', details->>'commentId')`;

/**
 * Same, for queries that emit both shapes: a v1-shaped model comment (no `threadType`) carries its
 * old v1 id, which can equal another surface's id, so it keeps the v1 namespace; everything else the
 * v2 one.
 */
export const commentDedupeKeyByShape = `concat('comment:', case when details->>'threadType' is not null then 'v2:' else 'v1:' end, details->>'commentId')`;

/**
 * The same key, but only claimed when the notification can actually be linked to. Claiming SUPPRESSES
 * every other notification for that comment, so a claimant that renders a dead link would silently
 * replace one that works.
 *
 * `threadType` resolves to the `'comment'` fallback for any entity `threadUrlMap` doesn't address
 * (model3dReview today). Those stay unclaimed, which is what lets a purpose-built owner notification
 * own the key instead. v1-shaped model comments carry no `threadType` and build their URL from
 * `modelId`, so they always render and always claim.
 *
 * `comicProject` IS addressed now, so it claims here. That does not strand the comic project owner's
 * richer `new-comic-comment` (which deep-links to the chapter): it shares this same `comment:v2:<id>`
 * key deliberately (see `comics.router.ts`), and is inserted synchronously at comment-creation, so its
 * `PendingNotification` is drained first and wins the partial-unique `(userId, dedupeKey)`. The owner
 * gets the one deep-linked comic notification; a non-owner thread participant, whom `new-comic-comment`
 * never targets, gets this working `/comics/<project>` link instead of the dead one it used to render.
 *
 * Add an entity type WITHOUT a `threadUrlMap` entry and this keeps the dedupe correct on its own —
 * that omission is exactly how the mention/challenge regression got in.
 */
export const commentDedupeKeyIfAddressable = `case
          when details->>'threadType' is null then ${commentDedupeKeyByShape}
          when details->>'threadType' <> 'comment' then ${commentDedupeKeyByShape}
        end`;

/**
 * Batch order for the comment family, lowest first. `send-notifications` runs each priority as its own
 * sequential batch, so this decides WHICH of several competing notifications a user actually receives:
 * the most specific one runs first and claims the dedupe key. Being named beats being replied to, which
 * beats being in the thread, which beats owning the thing it happened on.
 */
export const CommentNotificationPriority = {
  Mention: 1,
  DirectResponse: 2,
  ThreadResponse: 3,
  EntityOwner: 4,
} as const;

// Moveable (all)

/**
 * Everyone else in `c`'s conversation, live, unblocked and not muted, each author checked once. For a
 * top-level comment, the entity's other top-level comments of the same shape (a v2 comment on a
 * model thread never shared a thread with v1 ones); for a reply, everyone answering the same
 * comment, via `parentId` or the clamp's `replyToId`, found through that comment alone since a reply
 * shares its entity. Two arms rather than `IS NOT DISTINCT FROM`, which no index serves.
 */
const siblingAuthors = (sameParent: string) => `(SELECT ARRAY_AGG(s."userId") FROM (
                     SELECT DISTINCT cu."userId" FROM "CommentV3" cu
                     WHERE ${sameParent} AND cu."deletedAt" IS NULL AND NOT cu."tosViolation"
                       AND cu."userId" != c."userId"
                   ) s
                   WHERE ${notBlockedBetween('s."userId"', 'c."userId"')}
                     AND ${notCommentMuted('s."userId"', 'c')})`;

export const commentNotifications = createNotificationProcessor({
  'new-comment': {
    displayName: 'New comments on your models',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your ${details.modelName} model`,
      url: getModelCommentThreadUrl({ modelId: details.modelId, commentId: details.commentId }),
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comments AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'modelId', c."entityId",
            'commentId', ${legacyId('c')},
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."entityId"
        WHERE ${isV1Shaped('c')}
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND m."userId" > 0
          AND c."userId" != m."userId"
          AND ${notBlockedBetween('m."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-model:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v1')} "dedupeKey",
        "ownerId"    "userId",
        'new-comment' "type",
        details
      FROM new_comments r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment')
    `,
  },
  'new-comment-response': {
    defaultPush: true,
    displayName: 'New comment responses (Models)',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.DirectResponse,
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to your comment on ${withDefiniteArticle(
        details.modelName
      )} model`,
      url: getModelCommentThreadUrl({
        modelId: details.modelId,
        commentId: details.parentId ?? details.commentId,
        highlight: details.commentId,
      }),
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comment_response AS (
        SELECT DISTINCT
          pa."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'modelId', c."entityId",
            'commentId', ${legacyId('c')},
            'parentId', ${legacyId('p')},
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "CommentV3" p ON p.id = c."parentId"
        JOIN "CommentV3" pa ON pa.id = ${answeredId('c')} AND pa."deletedAt" IS NULL
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."entityId"
        WHERE ${isV1Shaped('c')}
          AND ${liveV3Since(lastSent)}
          AND m."userId" > 0
          AND c."userId" != pa."userId"
          AND ${notBlockedBetween('pa."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-response:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v1')} "dedupeKey",
        "ownerId"    "userId",
        'new-comment-response' "type",
        details
      FROM new_comment_response r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-response')
    `,
  },
  'new-comment-nested': {
    displayName: 'New responses to comments and reviews on your models',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to a ${details.parentType} on your ${details.modelName} model`,
      url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comments_nested AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'modelId', c."entityId",
            'commentId', ${legacyId('c')},
            'parentId', ${legacyId('p')},
            'parentType', 'comment',
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "CommentV3" p ON p.id = c."parentId"
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."entityId"
        WHERE ${isV1Shaped('c')}
          AND ${liveV3Since(lastSent)}
          AND m."userId" > 0
          AND c."userId" != m."userId"
          AND ${notBlockedBetween('m."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-nested:user:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v1')} "dedupeKey",
        "ownerId"    "userId",
        'new-comment-nested' "type",
        details
      FROM new_comments_nested r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-nested')
    `,
  },
  'new-comment-reply': {
    defaultPush: true,
    displayName: 'New comment replies',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.DirectResponse,
    prepareMessage: ({ details }) => {
      const url = threadUrlMap(details);
      return {
        message: `${details.username} replied to ${threadTypeWithArticle(
          details.threadType
        )} comment you made`,
        url,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_comment_reply AS (
        SELECT DISTINCT
          pc."userId" "ownerId",
          ${v3ThreadDetails('')} "details"
        FROM "CommentV3" c
        JOIN "CommentV3" pc ON pc.id = ${answeredId('c')} AND pc."deletedAt" IS NULL
        JOIN "User" u ON c."userId" = u.id
        ${v3EntityJoins('c')}
        WHERE NOT ${isV1Shaped('c')}
          AND ${liveV3Since(lastSent)}
          AND c."userId" != pc."userId"
          AND ${notBlockedBetween('pc."userId"', 'c."userId"')}
          AND ${notCommentMuted('pc."userId"', 'c')}
          AND ${v3AppListingResolved('c')}
      )
      SELECT
        concat('new-comment-reply:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKeyIfAddressable} "dedupeKey",
        "ownerId"    "userId",
        'new-comment-reply' "type",
        details
      FROM new_comment_reply r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-reply')
    `,
  },
  'new-thread-response': {
    displayName: 'New replies to comment threads you are in',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.ThreadResponse,
    prepareMessage: ({ details }) => {
      if (!details.threadType) {
        return {
          message: `${details.username} responded to the ${
            details.parentType
          } thread on ${withDefiniteArticle(details.modelName)} model`,
          url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      }

      const url = threadUrlMap(details);
      return {
        message: `${details.username} responded to ${threadTypeWithArticle(
          details.threadType
        )} thread you're in`,
        url,
      };
    },
    // v1-shaped model comments notify on replies only and keep that shape: their page's dialog still
    // reads `Comment`.
    prepareQuery: ({ lastSent }) => `
      WITH new_thread_response AS (
        SELECT DISTINCT
          UNNEST(CASE
            WHEN c."parentId" IS NULL THEN ${siblingAuthors(
              'cu."entityType" = c."entityType" AND cu."entityId" = c."entityId" AND cu."parentId" IS NULL AND (cu."legacyV1Id" IS NULL) = (c."legacyV1Id" IS NULL)'
            )}
            ELSE ${siblingAuthors(
              `((cu."parentId" = ${answeredId(
                'c'
              )} AND cu."replyToId" IS NULL) OR cu."replyToId" = ${answeredId('c')})`
            )}
          END) "ownerId",
          CASE WHEN ${isV1Shaped('c')} THEN JSONB_BUILD_OBJECT(
            'version', 3,
            'modelId', c."entityId",
            'commentId', ${legacyId('c')},
            'parentId', ${legacyId('p')},
            'parentType', 'comment',
            'modelName', m.name,
            'username', u.username
          ) ELSE ${v3ThreadDetails('')} END "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        LEFT JOIN "CommentV3" p ON p.id = c."parentId"
        LEFT JOIN "Model" m ON ${isV1Shaped('c')} AND m.id = c."entityId"
        ${v3EntityJoins('c')}
        WHERE ${liveV3Since(lastSent)}
          AND (NOT ${isV1Shaped('c')} OR c."parentId" IS NOT NULL)
          AND ${v3AppListingResolved('c')}
      )
      SELECT
        concat('new-thread-response:user:v3:', details->>'commentId') "key",
        ${commentDedupeKeyIfAddressable} "dedupeKey",
        "ownerId"    "userId",
        'new-thread-response' "type",
        details
      FROM new_thread_response r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-thread-response')
    `,
  },
  'new-review-response': {
    displayName: 'New review responses',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.DirectResponse,
    prepareMessage: ({ details }) => {
      if (!details.version) {
        return {
          message: `${details.username} responded to your review on ${withDefiniteArticle(
            details.modelName
          )} model`,
          url: `/models/${details.modelId}?dialog=reviewThread&reviewId=${details.reviewId}&highlight=${details.commentId}`,
        };
      }

      return {
        message: `${details.username} responded to your review on ${withDefiniteArticle(
          details.modelName
        )} model`,
        url: `/reviews/${details.reviewId}?highlight=${details.commentId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
    WITH new_review_response AS (
      SELECT DISTINCT
        r."userId" "ownerId",
        JSONB_BUILD_OBJECT(
          'version', 3,
          'modelId', r."modelId",
          'commentId', c.id,
          'reviewId', r.id,
          'modelName', m.name,
          'username', u.username
        ) as "details"
      FROM "CommentV3" c
      JOIN "ResourceReview" r ON r.id = c."entityId"
      JOIN "User" u ON c."userId" = u.id
      JOIN "Model" m ON m.id = r."modelId"
      WHERE c."entityType" = 'review'
        AND c."parentId" IS NULL
        AND ${liveV3Since(lastSent)}
        AND m."userId" > 0
        AND c."userId" != r."userId"
        AND ${notBlockedBetween('r."userId"', 'c."userId"')}
        AND ${notCommentMuted('r."userId"', 'c')}
      )
      SELECT
        concat('new-review-response:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-review-response' "type",
        details
      FROM new_review_response r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-review-response')
    `,
  },
  'new-image-comment': {
    displayName: 'New comments on your images',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => {
      if (details.version) {
        let message = `${details.username} commented on your image`;
        if (details.modelName)
          message += ` posted to ${withDefiniteArticle(details.modelName)} model`;
        const url = `/images/${details.imageId}?highlight=${details.commentId}`;
        return { message, url };
      }
      // Prep message
      const message = `${details.username} commented on your ${
        details.reviewId ? 'review image' : 'example image'
      } posted to ${withDefiniteArticle(details.modelName)} model`;
      // Prep URL
      const searchParams: Record<string, string> = {
        model: details.modelId,
        modelVersionId: details.modelVersionId,
        highlight: details.commentId,
        infinite: 'false',
      };
      if (details.reviewId) {
        searchParams.review = details.reviewId;
        searchParams.returnUrl = `/models/${details.modelId}?dialog=reviewThread&reviewId=${details.reviewId}`;
      } else {
        searchParams.returnUrl = `/models/${details.modelId}`;
      }
      const url = `/images/${details.imageId}?${new URLSearchParams(searchParams).toString()}`;

      return { message, url };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_image_comment AS (
        SELECT DISTINCT
          i."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'imageId', c."entityId",
            'postId', i."postId",
            'commentId', c.id,
            'username', u.username,
            'modelName', m.name,
            'modelId', m.id,
            'modelVersionId', p."modelVersionId",
            'modelVersionName', mv.name
          ) "details"
        FROM "CommentV3" c
        JOIN "Image" i ON i.id = c."entityId"
        JOIN "Post" p ON p.id = i."postId"
        LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        LEFT JOIN "Model" m ON m.id = mv."modelId"
        JOIN "User" u ON c."userId" = u.id
        WHERE c."entityType" = 'image'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND i."userId" > 0
          AND c."userId" != i."userId"
          AND ${notBlockedBetween('i."userId"', 'c."userId"')}
          AND ${notCommentMuted('i."userId"', 'c')}
      )
      SELECT
        concat('new-comment-image:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-image-comment' "type",
        details
      FROM new_image_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-image-comment');
    `,
  },
  'new-post-comment': {
    displayName: 'New comments on your posts',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => {
      // Post.title is nullable AND trims to '' rather than null when cleared, so both are untitled.
      if (details.postTitle)
        return {
          message: `${details.username} commented on your post: "${details.postTitle}"`,
          url: `/posts/${details.postId}?highlight=${details.commentId}`,
        };
      // Untitled is the common case for model-gallery posts, and without a disambiguator a creator
      // gets a run of identical rows. Same fallback new-image-comment uses.
      let message = `${details.username} commented on your post`;
      if (details.modelName) message += ` on ${withDefiniteArticle(details.modelName)} model`;
      return { message, url: `/posts/${details.postId}?highlight=${details.commentId}` };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_post_comment AS (
        SELECT DISTINCT
          p."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'postId', p.id,
            'postTitle', p.title,
            'commentId', c.id,
            'username', u.username,
            'modelName', m.name
          ) "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Post" p ON p.id = c."entityId"
        LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        LEFT JOIN "Model" m ON m.id = mv."modelId"
        WHERE c."entityType" = 'post'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND p."userId" > 0
          -- Two floors, because this type has no cursor row until its first successful run and so
          -- inherits the job's GLOBAL last-run: new Date(0) on a fresh DB, and stale by the outage
          -- duration after any send-notifications outage. Unfloored, one such deploy emits all 110k
          -- historical post comments (measured; the query returns them in 2.6s, well inside the 20s
          -- timeout, so nothing downstream stops it).
          -- The launch date is the guard new-bounty-comment carries. It only bites for the first week
          -- after it passes, but that is the window where a pre-launch comment could still be emitted.
          AND c."createdAt" > '2026-08-06'
          -- After that the rolling window is the one doing the work, and it never goes stale: it bounds
          -- any first batch to ~7 days (~500 rows at the measured 3/hour) however far the cursor drifted.
          AND c."createdAt" > NOW() - INTERVAL '7 days'
          AND c."userId" != p."userId"
          AND ${notBlockedBetween('p."userId"', 'c."userId"')}
          AND ${notCommentMuted('p."userId"', 'c')}
      )
      SELECT
        concat('new-comment-post:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-post-comment' "type",
        details
      FROM new_post_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-post-comment');
    `,
  },
  'new-app-listing-comment': {
    displayName: 'New comments on your app listings',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your app listing: "${details.listingName}"`,
      // 🔴 THE OWNER'S SUBMISSIONS VIEW, **NOT** the public listing detail page — a deliberate
      // reversal of the issue's suggestion.
      //
      // Kept for the record, because it is a real measurement and it is what the issue's
      // suggestion was rejected on at the time: `/apps/store-preview/<slug>` gates on
      // `hasAppsStoreAccess`, which rolls out to `moderators` OR `app-dev-testers` only, and of
      // the 4 listing owners on prod at 2026-08-20 one was in NEITHER cohort — so a deep link
      // 404s for the very person being notified. #4160's three types escaped this because their
      // recipient had already commented in the thread and had therefore already proven they
      // could open the page; this is the first app-listing notification pushed to an owner
      // UNCONDITIONALLY, so it cannot borrow that assumption.
      //
      // ⚠️ THAT MEASUREMENT NO LONGER SEPARATES THE TWO DESTINATIONS — see below. It rules the
      // public page out for that owner; it rules the chosen one out for them as well.
      //
      // 🔴 THE COHORT ARGUMENT THAT USED TO SIT HERE IS VOID, AND IS NOT REPLACED BY ANOTHER
      // ONE. It ran: `/apps/mine` gates on `isAppDeveloper` alone, so it needs "the developer
      // cohort rather than the narrower store-access one", making it the better destination
      // than a store-gated page. `/apps/mine` no longer exists — the consolidation moved this
      // constant to `/apps/build`, whose gate is `canAccessAppsBuild` =
      // `hasAppsStoreAccess(features) && (isAppDeveloper(user, …) || appBlocksGetStarted)`
      // (`shared/utils/app-blocks-access.ts`). Store access is now a hard AND, so this
      // destination REQUIRES the very term the paragraph above rejects, and then requires
      // more on top of it. Its admitted cohort is therefore a strict SUBSET of
      // `/apps/store-preview/<slug>`'s — narrower, not wider, which is the exact opposite
      // of what the old reason claimed.
      //
      // What still picks it is CONTENT, not reachability. This notification is about the
      // owner's own submission, and state C of `/apps/build` is that submissions table — the
      // moderation state, the reason a mod supplied, the edit link. The public detail page
      // renders the listing as a visitor sees it and carries none of that. It is also where
      // every other owner-facing app-listing notification lands, via this same shared
      // constant, so a route rename moves all of them at once.
      //
      // On whether the narrowing can strand the recipient: it cannot, under the live Flipt
      // config, and the proof is recorded once at `OWNER_SUBMISSIONS_URL` rather than restated
      // here. The short form is that `app-blocks-author` and the store flags roll out to the
      // SAME segments, so an author always clears the store term.
      url: OWNER_SUBMISSIONS_URL,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_app_listing_comment AS (
        SELECT DISTINCT
          ${APP_LISTING_OWNER_SQL} "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'commentId', c.id,
            'appListingSlug', al.slug,
            'listingName', al.name,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "app_listings" al ON al."serial_id" = c."entityId"
        -- Ownership chain for the onsite kind — see APP_LISTING_OWNER_SQL. LEFT, because an
        -- offsite listing has no block and an onsite one may carry a dangling app_id; both must
        -- still fall back to the column rather than drop the row.
        LEFT JOIN "app_blocks" ab ON ab.id = al."app_block_id"
        LEFT JOIN "OauthClient" oc ON oc.id = ab."app_id"
        WHERE c."entityType" = 'appListing'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND ${APP_LISTING_OWNER_SQL} > 0
          -- Only APPROVED listings. The destination reads through
          -- \`appListings.getAppDetail\`, which is approved-only, so a comment on a draft /
          -- rejected / moderator-removed listing would notify its owner toward a NotFound.
          -- Measured on prod: only 14 of 28 listings are approved. Mirrors the sibling raw-SQL
          -- consumer (appListing.metrics.sql.ts).
          AND al."status" = 'approved'
          -- Never a shadow revision. \`beginListingRevision\` clones an approved parent as a
          -- hidden draft; the clone freezes \`user_id\` at clone time and no ownership write
          -- revisits it, so a shadow can name a STALE owner. Not reachable today (shadows are
          -- draft, so the status filter already excludes them) — belt and braces, and it
          -- matches every Prisma-side ownership read.
          AND al."revision_of_id" IS NULL
          -- Two floors, for the reason new-post-comment carries them: this type has no cursor row
          -- until its first successful run, so it inherits the job's GLOBAL last-run — new Date(0)
          -- on a fresh DB, and stale by the outage duration after any send-notifications outage.
          AND c."createdAt" > '2026-08-19'
          -- The rolling window is the one that never goes stale: it bounds any first batch to
          -- ~7 days however far the cursor drifted.
          AND c."createdAt" > NOW() - INTERVAL '7 days'
          -- A commenter never notifies themselves for their own listing.
          AND c."userId" != ${APP_LISTING_OWNER_SQL}
          -- Argument ORDER is load-bearing: (recipient, actor). Swapped, the owner's Hide stops
          -- suppressing and the commenter's starts — a silent inversion of who gets muted.
          AND ${notBlockedBetween(APP_LISTING_OWNER_SQL, 'c."userId"')}
          AND ${notCommentMuted(APP_LISTING_OWNER_SQL, 'c')}
      )
      SELECT
        concat('new-comment-app-listing:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-app-listing-comment' "type",
        details
      FROM new_app_listing_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-app-listing-comment');
    `,
  },
  'new-article-comment': {
    displayName: 'New comments on your articles',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) =>
      details && !isEmpty(details)
        ? {
            message: `${details.username} commented on your article: "${details.articleTitle}"`,
            url: `/articles/${details.articleId}?highlight=${details.commentId}`,
          }
        : undefined,
    prepareQuery: ({ lastSent }) => `
      WITH new_article_comment AS (
        SELECT DISTINCT
          a."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'articleId', a.id,
            'articleTitle', a.title,
            'commentId', c.id,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Article" a ON a.id = c."entityId"
        WHERE c."entityType" = 'article'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND a."userId" > 0
          AND c."userId" != a."userId"
          AND ${notBlockedBetween('a."userId"', 'c."userId"')}
          AND ${notCommentMuted('a."userId"', 'c')}
      )
      SELECT
        concat('new-comment-article:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-article-comment' "type",
        details
      FROM new_article_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-article-comment');
    `,
  },
  'new-bounty-comment': {
    displayName: 'New comments on your bounty',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your bounty: "${details.bountyTitle}"`,
      url: `/bounties/${details.bountyId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_bounty_comment AS (
        SELECT DISTINCT
          b."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'bountyId', b.id,
            'bountyTitle', b.name,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Bounty" b ON b.id = c."entityId"
        WHERE c."entityType" = 'bounty'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND b."userId" > 0
          AND c."createdAt" > '2024-02-24'
          AND c."userId" != b."userId"
          AND ${notBlockedBetween('b."userId"', 'c."userId"')}
          AND ${notCommentMuted('b."userId"', 'c')}
      )
      SELECT
        concat('new-comment-bounty:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-bounty-comment' "type",
        details
      FROM new_bounty_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-bounty-comment');
    `,
  },
  'new-bounty-entry-comment': {
    displayName: 'New comments on your bounty entries',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your entry to the "${details.bountyTitle}" bounty`,
      // The canonical URL directly, rather than threadUrlMap's `/bounties/entries/{id}` — that one
      // only reaches the entry via a redirect, and threadUrlMap can't build this form because it is
      // handed the entry id alone, with no bountyId.
      url: `/bounties/${details.bountyId}/entries/${details.bountyEntryId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_bounty_entry_comment AS (
        SELECT DISTINCT
          be."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'bountyEntryId', be.id,
            'bountyId', b.id,
            'bountyTitle', b.name,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "BountyEntry" be ON be.id = c."entityId"
        JOIN "Bounty" b ON b.id = be."bountyId"
        WHERE c."entityType" = 'bountyEntry'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          -- BountyEntry."userId" is nullable (SetNull on user delete); NULL > 0 is NULL, so this drops
          -- orphaned entries as well as system-owned ones.
          AND be."userId" > 0
          -- A new type has no cursor row until its first successful run, so it inherits the job's
          -- global last-run: new Date(0) on a fresh DB, stale by the outage duration after any
          -- send-notifications outage. There are 21,812 historical entry comments across 3,876
          -- owners. Launch date is the guard new-bounty-comment carries; the rolling window is what
          -- still holds once that date is behind us.
          AND c."createdAt" > '2026-08-06'
          AND c."createdAt" > NOW() - INTERVAL '7 days'
          AND c."userId" != be."userId"
          AND ${notBlockedBetween('be."userId"', 'c."userId"')}
          AND ${notCommentMuted('be."userId"', 'c')}
      )
      SELECT
        concat('new-comment-bounty-entry:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-bounty-entry-comment' "type",
        details
      FROM new_bounty_entry_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-bounty-entry-comment');
    `,
  },
  'new-challenge-comment': {
    displayName: 'New comments on your challenges',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your challenge: "${details.challengeTitle}"`,
      url: `/challenges/${details.challengeId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_challenge_comment AS (
        SELECT DISTINCT
          ch."createdById" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'challengeId', ch.id,
            'challengeTitle', ch.title,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Challenge" ch ON ch.id = c."entityId"
        WHERE c."entityType" = 'challenge'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND ch."createdById" > 0
          AND c."userId" != ch."createdById"
          AND ${notBlockedBetween('ch."createdById"', 'c."userId"')}
          AND ${notCommentMuted('ch."createdById"', 'c')}
      )
      SELECT
        concat('new-comment-challenge:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId" "userId",
        'new-challenge-comment' "type",
        details
      FROM new_challenge_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-challenge-comment');
    `,
  },
  'new-crucible-comment': {
    displayName: 'New comments on your crucibles',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      // The name is null until the text has passed review as safe for everyone.
      message: `${details.username} commented on your crucible${
        details.crucibleName ? `: "${details.crucibleName}"` : ''
      }`,
      url: `/crucibles/${details.crucibleId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_crucible_comment AS (
        SELECT DISTINCT
          cr."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'crucibleId', cr.id,
            'crucibleName', CASE WHEN cr.ingestion = 'Scanned' AND NOT cr."textNsfw" THEN cr.name END,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Crucible" cr ON cr.id = c."entityId"
        WHERE c."entityType" = 'crucible'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND cr."userId" > 0
          AND c."userId" != cr."userId"
          AND ${notBlockedBetween('cr."userId"', 'c."userId"')}
          AND ${notCommentMuted('cr."userId"', 'c')}
      )
      SELECT
        concat('new-comment-crucible:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId" "userId",
        'new-crucible-comment' "type",
        details
      FROM new_crucible_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-crucible-comment');
    `,
  },
  'new-storyline-comment': {
    displayName: 'New comments on your storylines',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your storyline: "${details.storylineTitle}"`,
      url: `${storylineUrl(details.storylineId)}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_storyline_comment AS (
        SELECT DISTINCT
          s."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'storylineId', s.id,
            'storylineTitle', s.title,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Storyline" s ON s.id = c."entityId"
        WHERE c."entityType" = 'storyline'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND s."userId" > 0
          AND c."userId" != s."userId"
          AND NOT s."tosViolation"
          AND ${notBlockedBetween('s."userId"', 'c."userId"')}
          AND ${notCommentMuted('s."userId"', 'c')}
      )
      SELECT
        concat('new-comment-storyline:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId" "userId",
        'new-storyline-comment' "type",
        details
      FROM new_storyline_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-storyline-comment');
    `,
  },
  // Model3D comments mirror the Model 3-tier (`new-comment` / `new-comment-response` /
  // `new-comment-nested`) but dedupe under `comment:v2:`.
  'new-3d-model-comment': {
    displayName: 'New comments on your 3D models',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your 3D model: "${details.model3dName}"`,
      url: `/3d-models/${details.model3dId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_3d_model_comment AS (
        SELECT DISTINCT
          m3d."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'model3dId', m3d.id,
            'model3dName', m3d.name,
            'commentId', c.id,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model3D" m3d ON m3d.id = c."entityId"
        WHERE c."entityType" = 'model3d'
          AND c."parentId" IS NULL
          AND ${liveV3Since(lastSent)}
          AND m3d."userId" > 0
          AND c."userId" != m3d."userId"
          AND ${notBlockedBetween('m3d."userId"', 'c."userId"')}
          AND ${notCommentMuted('m3d."userId"', 'c')}
      )
      SELECT
        concat('new-comment-model3d:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-3d-model-comment' "type",
        details
      FROM new_3d_model_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-3d-model-comment');
    `,
  },
  'new-3d-model-comment-response': {
    displayName: 'New responses to your comments on 3D models',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.DirectResponse,
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to your comment on the 3D model "${details.model3dName}"`,
      url: `/3d-models/${details.model3dId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_3d_model_comment_response AS (
        SELECT DISTINCT
          pc."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'model3dId', c."entityId",
            'model3dName', m3d.name,
            'commentId', c.id,
            'parentId', pc.id,
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "CommentV3" pc ON pc.id = ${answeredId('c')} AND pc."deletedAt" IS NULL
        JOIN "Model3D" m3d ON m3d.id = c."entityId"
        JOIN "User" u ON c."userId" = u.id
        WHERE c."entityType" = 'model3d'
          AND ${liveV3Since(lastSent)}
          AND c."userId" != pc."userId"
          AND ${notBlockedBetween('pc."userId"', 'c."userId"')}
          AND ${notCommentMuted('pc."userId"', 'c')}
      )
      SELECT
        concat('new-comment-response-model3d:owner:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-3d-model-comment-response' "type",
        details
      FROM new_3d_model_comment_response
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-3d-model-comment-response')
    `,
  },
  'new-3d-model-comment-nested': {
    displayName: 'New nested comments on your 3D models',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to a comment on your 3D model "${details.model3dName}"`,
      url: `/3d-models/${details.model3dId}?highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_3d_model_comment_nested AS (
        SELECT DISTINCT
          m3d."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 3,
            'model3dId', m3d.id,
            'model3dName', m3d.name,
            'commentId', c.id,
            'parentId', ${answeredId('c')},
            'username', u.username
          ) "details"
        FROM "CommentV3" c
        JOIN "Model3D" m3d ON m3d.id = c."entityId"
        JOIN "User" u ON c."userId" = u.id
        WHERE c."entityType" = 'model3d'
          AND c."parentId" IS NOT NULL
          AND ${liveV3Since(lastSent)}
          AND m3d."userId" > 0
          AND c."userId" != m3d."userId"
          AND ${notBlockedBetween('m3d."userId"', 'c."userId"')}
          AND ${notCommentMuted('m3d."userId"', 'c')}
      )
      SELECT
        concat('new-comment-nested-model3d:user:v3:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-3d-model-comment-nested' "type",
        details
      FROM new_3d_model_comment_nested
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-3d-model-comment-nested')
    `,
  },
});
