import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import {
  CommentNotificationPriority,
  commentDedupeKeyByShape,
  isModelComment,
  modelPageId,
  notOnHiddenModel,
  notOnHiddenPostText,
  notOnUnpublishedArticle,
  threadTypeLabel,
  threadUrlMap,
  v3AppListingResolved,
  v3EntityJoins,
  v3ThreadDetails,
  withIndefiniteArticle,
} from '~/server/notifications/comment.notifications';

// Edits re-emit the comment's key, relying on UserNotification's unique (notificationId, userId) to
// skip people already told. Those rows are cleaned up, so don't widen the window to old comments.
// An author can still edit a comment moderation removed, hence the visibility filters.
const liveCommentCreatedOrEditedSince = (lastSent: string) =>
  `c."createdAt" > '${lastSent}'::timestamp - interval '1 day'
          AND (c."createdAt" > '${lastSent}' OR c."updatedAt" > '${lastSent}')
          AND c."tosViolation" = false
          AND c.hidden IS NOT TRUE`;

export const ARTICLE_MENTION_CAP = 10;
export const ARTICLE_MENTION_EDIT_WINDOW = '30 days';
// GREATEST skips NULLs, so a never-scanned article still counts its publish and edit times.
const ARTICLE_TOUCHED_AT = `GREATEST(a."publishedAt", a."updatedAt", a."contentScannedAt")`;

/**
 * People named in a live article, each once: the first `ARTICLE_MENTION_CAP` who would be notified,
 * in document order. Recipient filters run before the cap, so names that can't be told don't use it
 * up. The cap is per run, not per article lifetime: nothing outside the notification rows records who
 * was told.
 *
 * Re-read when the article goes live or is edited since the last run. Like comment edits, it
 * re-emits the article's key and relies on UserNotification's unique (notificationId, userId) to
 * skip people already told. Those rows are deleted by the admin cleanup with a caller-chosen cutoff,
 * so the window after publish only holds while that cutoff is older than the window.
 * `contentScannedAt` is a trigger too: the scan that clears an edit marks the article Scanned with
 * raw SQL that leaves `updatedAt` alone, and until then `ingestion` keeps it from notifying.
 *
 * Unlisted and Private articles are skipped: the notification would hand out a link the author kept
 * off the feed. The ingestion and browsingLevel gates match the article feed's.
 */
export const articleMentionsSql = (lastSent: string) => `
        SELECT
          am."ownerId",
          a."userId" "actorId",
          JSONB_BUILD_OBJECT(
            'mentionedIn', 'article',
            'articleId', a.id,
            'articleTitle', a.title,
            'username', u.username
          ) "details"
        FROM "Article" a
        JOIN "User" u ON u.id = a."userId"
        CROSS JOIN LATERAL (
          SELECT x.id "ownerId"
          FROM (
            SELECT CAST(r.m[1] AS INT) id, MIN(r.ord) first_at
            FROM regexp_matches(a.content, '"mention:(\\d+)"', 'g') WITH ORDINALITY r(m, ord)
            GROUP BY 1
          ) x
          JOIN "User" ru ON ru.id = x.id
          WHERE x.id <> a."userId"
            AND ru."bannedAt" IS NULL
            AND ru."deletedAt" IS NULL
            AND (a."nsfwLevel" & ru."browsingLevel") <> 0
            AND NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = ru.id AND type = 'new-mention')
            AND ${notBlockedBetween('ru.id', 'a."userId"')}
          ORDER BY x.first_at
          LIMIT ${ARTICLE_MENTION_CAP}
        ) am
        -- Matches "Article_mention_scan_idx" exactly (expression and partial predicate), or this is
        -- a seq scan of every article each run.
        WHERE ${ARTICLE_TOUCHED_AT} > '${lastSent}'
          AND a.status = 'Published'
          AND a.ingestion = 'Scanned'
          AND a."publishedAt" > now() - interval '${ARTICLE_MENTION_EDIT_WINDOW}'
          AND a."publishedAt" <= now()
          AND NOT a."tosViolation"
          AND NOT a.unlisted
          AND a.availability <> 'Private'
          AND a.content LIKE '%"mention:%'
          AND u."bannedAt" IS NULL
          AND NOT u.muted`;

// Moveable (possibly)

export const mentionNotifications = createNotificationProcessor({
  'new-mention': {
    defaultPush: true,
    displayName: 'New @mentions',
    category: NotificationCategory.Comment,
    priority: CommentNotificationPriority.Mention,
    prepareMessage: ({ details }) => {
      const isThreadAddressed =
        details.mentionedIn === 'comment' && details.threadType !== undefined;
      if (isThreadAddressed) {
        const url = threadUrlMap(details);
        // The shared `threadTypeLabel` names the ENTITY; `'comment thread'` is this sentence's
        // own shaping of the unaddressable fallback ("…on a comment thread" reads, "…on a
        // comment" does not) and stays local — folding it into the shared map would give the
        // reply consumers "a comment thread comment you made".
        //
        // The article comes from `withIndefiniteArticle`, which is handed the noun and nothing
        // else, so it cannot disagree with the word printed beside it. See its docstring.
        const noun =
          details.threadType === 'comment' ? 'comment thread' : threadTypeLabel(details.threadType);
        return {
          message: `${details.username} mentioned you in a comment on ${withIndefiniteArticle(
            noun
          )}`,
          url,
        };
      } else if (details.mentionedIn === 'comment') {
        if (details.parentType === 'review') return;

        return {
          message: `${details.username} mentioned you in a ${details.parentType} on ${details.modelName}`,
          url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      } else if (details.mentionedIn === 'article') {
        return {
          message: `${details.username} mentioned you in the article "${details.articleTitle}"`,
          url: `/articles/${details.articleId}`,
        };
      }
      return {
        message: `${details.username} mentioned you in the description of ${details.modelName}`,
        url: `/models/${details.modelId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_mentions AS (
        SELECT DISTINCT
          CAST(unnest(regexp_matches(c.content, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
          -- The recipient is produced by unnest() in this select list, so it can't be referenced
          -- from these WHERE clauses. The author is carried out instead, and the block filter runs
          -- once on the outer query where both sides are finally in scope.
          c."userId" "actorId",
          CASE WHEN ${isModelComment('c')} THEN JSONB_BUILD_OBJECT(
            'version', 4,
            'mentionedIn', 'comment',
            'modelId', c."entityId",
            'commentId', ${modelPageId('c')},
            'parentId', ${modelPageId('p')},
            'parentType', CASE WHEN c."parentId" IS NOT NULL THEN 'comment' ELSE 'review' END,
            'modelName', m.name,
            'username', u.username
          ) ELSE ${v3ThreadDetails(`'mentionedIn', 'comment',`)} END "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        LEFT JOIN "CommentV3" p ON p.id = c."parentId"
        LEFT JOIN "Model" m ON ${isModelComment('c')} AND m.id = c."entityId"
        ${v3EntityJoins('c')}
        WHERE ${liveCommentCreatedOrEditedSince(lastSent)}
          AND c."deletedAt" IS NULL
          AND c.content LIKE '%"mention:%'
          AND (NOT ${isModelComment('c')} OR m."userId" > 0)
          -- Same slug-resolution guard the reply processors carry: those threads are addressed by
          -- SLUG, the join above supplies it, and only a row the join failed on is dropped.
          AND ${v3AppListingResolved('c')}
          AND ${notOnUnpublishedArticle('c')}
          AND ${notOnHiddenModel('c')}
          AND ${notOnHiddenPostText('c')}

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
          AND (m."publishedAt" > '${lastSent}' OR m."updatedAt" > '${lastSent}')
          AND m.description LIKE '%"mention:%'
          AND m.status = 'Published'

        UNION
${articleMentionsSql(lastSent)}
      )
      SELECT
        concat('new-mention:user:', case when details->>'mentionedIn' = 'model' then 'model:' when details->>'mentionedIn' = 'article' then 'article:' when details->>'threadType' is not null then 'v2:' else 'v1:' end, coalesce(details->>'commentId', details->>'modelId', details->>'articleId')) "key",
        -- Claiming the dedupe key SUPPRESSES every other notification for this comment, so only claim it
        -- when this mention is a worthy replacement — i.e. prepareMessage above yields a message AND a
        -- working URL. Three ways it doesn't:
        --   * mentionedIn = 'model' — a model DESCRIPTION mention, no comment behind it at all
        --   * threadType 'comment' — the fallback for an entity threadUrlMap can't address, which
        --     renders a dead link
        --   * model parentType 'review' — prepareMessage bails and returns undefined, so the row
        --     renders as NOTHING. Left unguarded this silently swallows the new-comment the user
        --     should have got.
        -- Anything excluded here still delivers as its own (lower-priority) notification, unchanged.
        case
          when details->>'mentionedIn' <> 'comment' then null
          when details->>'threadType' is not null then
            case when details->>'threadType' <> 'comment' then ${commentDedupeKeyByShape} end
          when details->>'parentType' = 'comment' then ${commentDedupeKeyByShape}
        end "dedupeKey",
        "ownerId"    "userId",
        'new-mention' "type",
        details
      FROM new_mentions r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-mention')
        AND ${notBlockedBetween('r."ownerId"', 'r."actorId"')}
    `,
  },
});
