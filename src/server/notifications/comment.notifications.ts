import { isEmpty } from 'lodash-es';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import { QS } from '~/utils/qs';

/**
 * SQL fragment resolving an app-store listing's public SLUG for a CommentsV2 thread.
 *
 * Every OTHER thread entity is id-addressed, so its URL is built straight from
 * `threadParentId` (the id the thread row already carries). App-listing pages are
 * SLUG-addressed (`/apps/store-preview/<slug>`) while `Thread.appListingId` holds
 * `app_listings.serial_id` — an INTEGER surrogate that appears nowhere in the URL. So the
 * slug has to be joined in, and `appListingSlug` carried in `details` beside the ids.
 *
 * LEFT JOIN, and the caller pairs it with `appListingSlugResolved` below: an app-listing
 * thread whose listing row does not resolve must be DROPPED rather than emitted with a
 * `/apps/store-preview/undefined` link.
 *
 * `expr` is the SQL expression naming the thread's `appListingId` — `root."appListingId"`
 * where only the root thread is in scope, `COALESCE(root."appListingId", t."appListingId")`
 * where the entity parent may sit on either.
 */
export const appListingSlugJoin = (expr: string) =>
  `LEFT JOIN "app_listings" al ON al."serial_id" = ${expr}`;

/**
 * Companion guard for `appListingSlugJoin`. Keeps every non-app-listing thread, and keeps an
 * app-listing thread only when the join produced a slug.
 *
 * 🔴 This is NOT the old blanket `appListingId IS NULL` exclusion it replaced. That one dropped
 * EVERY app-listing thread because no URL could be built for any of them; this one drops only the
 * rows the join failed on (structurally unreachable today — `slug` is `NOT NULL` and the FK is
 * `ON DELETE SET NULL`, so a resolvable `appListingId` always has a slug).
 */
export const appListingSlugResolved = (expr: string) => `(${expr} IS NULL OR al.slug IS NOT NULL)`;

/**
 * Human-readable noun for a thread type in notification copy.
 *
 * `threadType` is an entity KEY, and most of them happen to read as English. `appListing` does
 * not — untranslated it prints "an appListing" — so it gets a label.
 *
 * ONE map, read by every consumer that names a thread in a sentence (`new-mention`,
 * `new-comment-reply`, `new-thread-response`), so the same thread is called the same thing
 * wherever the user meets it. It used to live at one call site only, which is exactly how two
 * of the three shipped the raw key.
 */
export const threadTypeLabel = (threadType: string): string =>
  threadType === 'appListing' ? 'app listing' : threadType;

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
    comicChapter: `/comics/${threadParentId}?${queryString}`,
    model3d: `/3d-models/${threadParentId}?${queryString}`,
    // The one SLUG-addressed entry — see `appListingSlugJoin`. `threadParentId` is NOT the
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
 * same dedupe key, and the notifications app hands the recipient only the first one to land. `v1` is the
 * legacy `Comment` table, `v2` is `CommentV2` — their ids overlap, so the namespace is load-bearing.
 */
export const commentDedupeKey = (version: 'v1' | 'v2') =>
  `concat('comment:${version}:', details->>'commentId')`;

/** Same, for queries that UNION both comment tables and mark the V2 branch with `details.version`. */
export const commentDedupeKeyByVersion = `concat('comment:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId')`;

/**
 * The same key, but only claimed when the notification can actually be linked to. Claiming SUPPRESSES
 * every other notification for that comment, so a claimant that renders a dead link would silently
 * replace one that works.
 *
 * `threadType` resolves to the `'comment'` fallback for any `Thread` entity `threadUrlMap` doesn't
 * address (comicProject, clubPost, model3dReview today). Those threads stay unclaimed, which is what
 * lets a purpose-built owner notification like `new-comic-comment` own the key instead. V1 rows carry no
 * `threadType` and build their URL from `modelId`, so they always render and always claim.
 *
 * Add a `Thread` entity column WITHOUT a `threadUrlMap` entry and this keeps the dedupe correct on its
 * own — that omission is exactly how the mention/challenge regression got in.
 */
export const commentDedupeKeyIfAddressable = `case
          when details->>'version' is null then ${commentDedupeKeyByVersion}
          when details->>'threadType' <> 'comment' then ${commentDedupeKeyByVersion}
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

export const commentNotifications = createNotificationProcessor({
  'new-comment': {
    displayName: 'New comments on your models',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.EntityOwner,
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your ${details.modelName} model`,
      url: `/models/${details.modelId}?dialog=commentThread&commentId=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comments AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND c."parentId" IS NULL
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m."userId"
          AND ${notBlockedBetween('m."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-model:owner:v1:', details->>'commentId') "key",
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
    displayName: 'New comment responses (Models)',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.DirectResponse,
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to your comment on the ${details.modelName} model`,
      url: `/models/${details.modelId}?dialog=commentThread&commentId=${
        details.parentId ?? details.commentId
      }&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comment_response AS (
        SELECT DISTINCT
          p."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'parentId', p.id,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "Comment" p ON p.id = c."parentId"
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != p."userId"
          AND ${notBlockedBetween('p."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-response:owner:v1:', details->>'commentId') "key",
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
          AND c."parentId" IS NOT NULL
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m."userId"
          AND ${notBlockedBetween('m."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-nested:user:v1:', details->>'commentId') "key",
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
                -- App-store listing threads are SLUG-addressed, so this arm keys on the
                -- JOINED slug rather than on an id column. al only joins through
                -- root."appListingId", so a non-null slug already means: this is an
                -- appListing thread AND its listing resolved.
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
        ${appListingSlugJoin('root."appListingId"')}
        WHERE c."createdAt" > '${lastSent}' AND c."userId" != pc."userId"
          AND ${notBlockedBetween('pc."userId"', 'c."userId"')}
          -- appListing (app-store listing) threads DO emit replies now — the join above
          -- resolves the slug threadUrlMap needs. This drops only the rows that join
          -- failed on, so we never ship an unlinkable notification. (appListingId lives
          -- on the root here.)
          AND ${appListingSlugResolved('root."appListingId"')}
      )
      SELECT
        concat('new-comment-reply:owner:v2:', details->>'commentId') "key",
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
      if (!details.version) {
        return {
          message: `${details.username} responded to the ${details.parentType} thread on the ${details.modelName} model`,
          url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      }

      const url = threadUrlMap(details);
      return {
        // Was `a ${startCase(threadType)}` — Title Case mid-sentence, with a hardcoded "a" that
        // was already wrong for every vowel-initial type ("a Article thread", "a Image thread").
        // The shared label + article fixes the article for all of them and stops `appListing`
        // printing as a raw key.
        message: `${details.username} responded to ${threadTypeWithArticle(
          details.threadType
        )} thread you're in`,
        url,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_thread_response AS (
        SELECT DISTINCT
          UNNEST((SELECT ARRAY_AGG("userId") FROM "Comment" cu WHERE cu."parentId" = c."parentId" AND cu."userId" != c."userId" AND ${notBlockedBetween(
            'cu."userId"',
            'c."userId"'
          )})) "ownerId",
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
        WHERE c."parentId" IS NOT NULL AND c."createdAt" > '${lastSent}'

        UNION

        SELECT DISTINCT
          UNNEST((SELECT ARRAY_AGG("userId") FROM "CommentV2" cu WHERE cu."threadId" = c."threadId" AND cu."userId" != c."userId" AND ${notBlockedBetween(
            'cu."userId"',
            'c."userId"'
          )})) "ownerId",
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
              -- SLUG-addressed; see the same arm in new-comment-reply above.
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
        ${appListingSlugJoin('COALESCE(root."appListingId", t."appListingId")')}
        WHERE c."createdAt" > '${lastSent}'
          -- Unhandled thread types...
          AND t."questionId" IS NULL
          AND t."answerId" IS NULL
          -- appListing threads emit here too, via the joined slug. COALESCE over BOTH the
          -- root and the immediate thread, because the entity parent may sit on either.
          AND ${appListingSlugResolved('COALESCE(root."appListingId", t."appListingId")')}
      )
      SELECT
        concat('new-thread-response:user:', case when details->>'version' is not null then 'v2:' else 'v1:' end, details->>'commentId') "key",
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
      if (details.version !== 2) {
        return {
          message: `${details.username} responded to your review on the ${details.modelName} model`,
          url: `/models/${details.modelId}?dialog=reviewThread&reviewId=${details.reviewId}&highlight=${details.commentId}`,
        };
      }

      return {
        message: `${details.username} responded to your review on the ${details.modelName} model`,
        url: `/reviews/${details.reviewId}?highlight=${details.commentId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
    WITH new_review_response AS (
      SELECT DISTINCT
        r."userId" "ownerId",
        JSONB_BUILD_OBJECT(
          'version', 2,
          'modelId', r."modelId",
          'commentId', c.id,
          'reviewId', r.id,
          'modelName', m.name,
          'username', u.username
        ) as "details"
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      JOIN "ResourceReview" r ON r.id = t."reviewId"
      JOIN "User" u ON c."userId" = u.id
      JOIN "Model" m ON m.id = r."modelId"
      WHERE m."userId" > 0
        AND c."createdAt" > '${lastSent}'
        AND c."userId" != r."userId"
        AND ${notBlockedBetween('r."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-review-response:owner:v2:', details->>'commentId') "key",
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
      if (details.version === 2) {
        let message = `${details.username} commented on your image`;
        if (details.modelName) message += ` posted to the ${details.modelName} model`;

        const url = `/images/${details.imageId}?highlight=${details.commentId}`;
        return { message, url };
      }

      // Prep message
      const message = `${details.username} commented on your ${
        details.reviewId ? 'review image' : 'example image'
      } posted to the ${details.modelName} model`;

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
            'version', 2,
            'imageId', t."imageId",
            'postId', i."postId",
            'commentId', c.id,
            'username', u.username,
            'modelName', m.name,
            'modelId', m.id,
            'modelVersionId', p."modelVersionId",
            'modelVersionName', mv.name
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId" AND t."imageId" IS NOT NULL
        JOIN "Image" i ON i.id = t."imageId"
        JOIN "Post" p ON p.id = i."postId"
        LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        LEFT JOIN "Model" m ON m.id = mv."modelId"
        JOIN "User" u ON c."userId" = u.id
        WHERE i."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != i."userId"
          AND ${notBlockedBetween('i."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-image:owner:v2:', details->>'commentId') "key",
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
      if (details.modelName) message += ` on the ${details.modelName} model`;
      return { message, url: `/posts/${details.postId}?highlight=${details.commentId}` };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_post_comment AS (
        SELECT DISTINCT
          p."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'postId', p.id,
            'postTitle', p.title,
            'commentId', c.id,
            'username', u.username,
            'modelName', m.name
          ) "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."postId" IS NOT NULL
        JOIN "Post" p ON p.id = t."postId"
        LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        LEFT JOIN "Model" m ON m.id = mv."modelId"
        WHERE p."userId" > 0
          AND c."createdAt" > '${lastSent}'
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
      )
      SELECT
        concat('new-comment-post:owner:v2:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId"    "userId",
        'new-post-comment' "type",
        details
      FROM new_post_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-post-comment');
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
            'version', 2,
            'articleId', a.id,
            'articleTitle', a.title,
            'commentId', c.id,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."articleId" IS NOT NULL
        JOIN "Article" a ON a.id = t."articleId"
        WHERE a."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != a."userId"
          AND ${notBlockedBetween('a."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-article:owner:v2:', details->>'commentId') "key",
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
            'version', 2,
            'bountyId', b.id,
            'bountyTitle', b.name,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."bountyId" IS NOT NULL
        JOIN "Bounty" b ON b.id = t."bountyId"
        WHERE b."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."createdAt" > '2024-02-24'
          AND c."userId" != b."userId"
          AND ${notBlockedBetween('b."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-bounty:owner:v2:', details->>'commentId') "key",
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
            'version', 2,
            'bountyEntryId', be.id,
            'bountyId', b.id,
            'bountyTitle', b.name,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."bountyEntryId" IS NOT NULL
        JOIN "BountyEntry" be ON be.id = t."bountyEntryId"
        JOIN "Bounty" b ON b.id = be."bountyId"
        -- BountyEntry."userId" is nullable (SetNull on user delete); NULL > 0 is NULL, so this drops
        -- orphaned entries as well as system-owned ones.
        WHERE be."userId" > 0
          AND c."createdAt" > '${lastSent}'
          -- A new type has no cursor row until its first successful run, so it inherits the job's
          -- global last-run: new Date(0) on a fresh DB, stale by the outage duration after any
          -- send-notifications outage. There are 21,812 historical entry comments across 3,876
          -- owners. Launch date is the guard new-bounty-comment carries; the rolling window is what
          -- still holds once that date is behind us.
          AND c."createdAt" > '2026-08-06'
          AND c."createdAt" > NOW() - INTERVAL '7 days'
          AND c."userId" != be."userId"
          AND ${notBlockedBetween('be."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-bounty-entry:owner:v2:', details->>'commentId') "key",
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
            'version', 2,
            'challengeId', ch.id,
            'challengeTitle', ch.title,
            'commentId', c.id,
            'username', u.username
          ) as "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."challengeId" IS NOT NULL
        JOIN "Challenge" ch ON ch.id = t."challengeId"
        WHERE ch."createdById" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != ch."createdById"
          AND ${notBlockedBetween('ch."createdById"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-challenge:owner:v2:', details->>'commentId') "key",
        ${commentDedupeKey('v2')} "dedupeKey",
        "ownerId" "userId",
        'new-challenge-comment' "type",
        details
      FROM new_challenge_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-challenge-comment');
    `,
  },
  // Model3D comments — mirror the Model 3-tier (`new-comment` /
  // `new-comment-response` / `new-comment-nested`) but use the CommentV2 +
  // Thread surface (Model3D never used the V1 `Comment` table).
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
            'version', 2,
            'model3dId', m3d.id,
            'model3dName', m3d.name,
            'commentId', c.id,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."model3dId" IS NOT NULL
        JOIN "Model3D" m3d ON m3d.id = t."model3dId"
        WHERE m3d."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m3d."userId"
          AND ${notBlockedBetween('m3d."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-model3d:owner:v2:', details->>'commentId') "key",
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
      -- A "response" here is a CommentV2 whose Thread is rooted at a parent
      -- CommentV2 (Thread.commentId) that itself lives inside a Model3D
      -- thread. We notify the parent comment's author. Mirrors the
      -- Model-side new-comment-response shape.
      WITH new_3d_model_comment_response AS (
        SELECT DISTINCT
          pc."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'model3dId', root."model3dId",
            'model3dName', m3d.name,
            'commentId', c.id,
            'parentId', pc.id,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId"
        JOIN "CommentV2" pc ON pc.id = t."commentId"
        JOIN "Thread" root ON root.id = t."rootThreadId"
        JOIN "Model3D" m3d ON m3d.id = root."model3dId"
        JOIN "User" u ON c."userId" = u.id
        WHERE root."model3dId" IS NOT NULL
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != pc."userId"
          AND ${notBlockedBetween('pc."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-response-model3d:owner:v2:', details->>'commentId') "key",
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
      -- A "nested" Model3D comment is a CommentV2 whose Thread is anchored
      -- in a comment under the model3d root thread. The Model3D owner gets
      -- the heads-up (the parent comment's author is covered by
      -- new-3d-model-comment-response). Mirrors the Model new-comment-nested
      -- shape.
      WITH new_3d_model_comment_nested AS (
        SELECT DISTINCT
          m3d."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'model3dId', m3d.id,
            'model3dName', m3d.name,
            'commentId', c.id,
            'parentId', t."commentId",
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId" AND t."commentId" IS NOT NULL
        JOIN "Thread" root ON root.id = t."rootThreadId"
        JOIN "Model3D" m3d ON m3d.id = root."model3dId"
        JOIN "User" u ON c."userId" = u.id
        WHERE root."model3dId" IS NOT NULL
          AND m3d."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m3d."userId"
          AND ${notBlockedBetween('m3d."userId"', 'c."userId"')}
      )
      SELECT
        concat('new-comment-nested-model3d:user:v2:', details->>'commentId') "key",
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
