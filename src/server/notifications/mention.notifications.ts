import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import {
  CommentNotificationPriority,
  commentDedupeKeyByShape,
  isV1Shaped,
  legacyId,
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
          CASE WHEN ${isV1Shaped('c')} THEN JSONB_BUILD_OBJECT(
            'version', 3,
            'mentionedIn', 'comment',
            'modelId', c."entityId",
            'commentId', ${legacyId('c')},
            'parentId', ${legacyId('p')},
            'parentType', CASE WHEN c."parentId" IS NOT NULL THEN 'comment' ELSE 'review' END,
            'modelName', m.name,
            'username', u.username
          ) ELSE ${v3ThreadDetails(`'mentionedIn', 'comment',`)} END "details"
        FROM "CommentV3" c
        JOIN "User" u ON c."userId" = u.id
        LEFT JOIN "CommentV3" p ON p.id = c."parentId"
        LEFT JOIN "Model" m ON ${isV1Shaped('c')} AND m.id = c."entityId"
        ${v3EntityJoins('c')}
        WHERE ${liveCommentCreatedOrEditedSince(lastSent)}
          AND c."deletedAt" IS NULL
          AND c.content LIKE '%"mention:%'
          AND (NOT ${isV1Shaped('c')} OR m."userId" > 0)
          -- Same slug-resolution guard the reply processors carry: those threads are addressed by
          -- SLUG, the join above supplies it, and only a row the join failed on is dropped.
          AND ${v3AppListingResolved('c')}

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
      )
      SELECT
        concat('new-mention:user:', case when details->>'mentionedIn' = 'model' then 'model:' when details->>'threadType' is not null then 'v2:' else 'v1:' end, coalesce(details->>'commentId', details->>'modelId')) "key",
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
