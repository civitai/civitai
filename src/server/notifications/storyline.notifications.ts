import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import { STORYLINE_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import {
  storyLevelText,
  storylineRootVisibleText,
} from '~/server/services/storyline-visibility.sql';

/**
 * Continuations are placements on the `storyline` surface: the target is the chapter post being
 * continued, `data.postId` is the post offered as the next chapter, the owner is the storyline's
 * owner and the placer is the contributor.
 *
 * Three types rather than one with branches, so each can be muted on its own. None of them says
 * anything about Buzz: a continuation may be priced at zero, and a decline's fee and refund settle
 * after the row is resolved, so a money sentence could be false when it is read.
 *
 * A fee-waived decline was made by the system (a block, a host that can no longer be shown), not
 * by the owner, so it is not announced as theirs.
 *
 * A continuation from a post still a draft or being scanned is written pending but hidden from the
 * owner's queue until the readiness pass clears `awaitingReadiness` and stamps `readyAt`, so it is
 * announced when it becomes reviewable, not when it was submitted.
 *
 * An endorsed collaborator's continuation is approved by the system (no `resolvedById`), so its
 * approval does not name the owner.
 *
 * Every type drops a pair with a block between them. A block declines the pair's pending
 * continuations in both directions, and without the filter that decline is announced to the
 * blocked side, naming the blocker.
 */
function continuationRows({ named }: { named: 'placer' | 'owner' }) {
  const namedColumn = named === 'placer' ? 'p."placerId"' : 'p."ownerId"';
  const recipientColumn = named === 'placer' ? 'p."ownerId"' : 'p."placerId"';
  return `
    FROM "Placement" p
    JOIN "StorylineChapter" c ON c."postId" = p."targetId"
    JOIN "Storyline" s ON s.id = c."storylineId"
    JOIN "User" u ON u.id = ${namedColumn}
    WHERE p.surface = 'storyline'
      AND p."targetType" = 'post'
      AND p."ownerId" = s."userId"
      AND NOT s."tosViolation"
      AND ${notBlockedBetween(recipientColumn, namedColumn)}
  `;
}

const resolvedQuery = ({
  type,
  status,
  lastSent,
}: {
  type: string;
  status: 'approved' | 'declined';
  lastSent: string;
}) => `
  WITH data AS (
    SELECT
      p."placerId" "userId",
      p.id "placementId",
      jsonb_build_object(
        'placementId', p.id,
        'storylineId', s.id,
        'storylineTitle', s.title,
        'postId', p.data->'postId',
        'ownerId', p."ownerId",
        'ownerUsername', u.username,
        'byOwner', p."resolvedById" IS NOT NULL
      ) as "details"
    ${continuationRows({ named: 'owner' })}
      AND p.status = '${status}'
      ${status === 'declined' ? 'AND NOT p."feeWaived"' : ''}
      AND p."resolvedAt" IS NOT NULL
      AND p."resolvedAt" > '${lastSent}'
  )
  SELECT
    CONCAT('${type}:',"placementId") "key",
    "userId",
    '${type}' "type",
    details
  FROM data
  WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = '${type}')
`;

export const storylineNotifications = createNotificationProcessor({
  'storyline-continuation-submitted': {
    displayName: 'Someone wants to continue your storyline',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} wants to continue your storyline "${details.storylineTitle}"`,
      url: STORYLINE_QUEUE_RECEIVED_URL,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."ownerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'storylineId', s.id,
            'storylineTitle', s.title,
            'postId', p.data->'postId',
            'placerId', p."placerId",
            'placerUsername', u.username
          ) as "details"
        ${continuationRows({ named: 'placer' })}
          AND p.status = 'pending'
          AND NOT (p.data ? 'awaitingReadiness')
          AND COALESCE((p.data->>'readyAt')::timestamptz AT TIME ZONE 'UTC', p."createdAt") > '${lastSent}'
      )
      SELECT
        CONCAT('storyline-continuation-submitted:',"placementId") "key",
        "userId",
        'storyline-continuation-submitted' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'storyline-continuation-submitted')
    `,
  },

  'storyline-continuation-approved': {
    displayName: 'Your storyline continuation was added',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      // `byOwner` is absent on notifications sent before it existed; those were all the owner's.
      message:
        details.byOwner === false
          ? `Your chapter was added to "${details.storylineTitle}"`
          : `${details.ownerUsername} added your chapter to "${details.storylineTitle}"`,
      url: storylineUrl(details.storylineId as number),
    }),
    prepareQuery: async ({ lastSent }) =>
      resolvedQuery({ type: 'storyline-continuation-approved', status: 'approved', lastSent }),
  },

  'storyline-continuation-declined': {
    displayName: 'Your storyline continuation was declined',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.ownerUsername} declined your continuation of "${details.storylineTitle}"`,
      url: storylineUrl(details.storylineId as number),
    }),
    prepareQuery: async ({ lastSent }) =>
      resolvedQuery({ type: 'storyline-continuation-declined', status: 'declined', lastSent }),
  },
});

/** Answered on the storyline's page, which offers Accept and Decline to the invitee. */
export const storylineInviteNotifications = createNotificationProcessor({
  'storyline-collaborator-invited': {
    displayName: 'You were invited to collaborate on a storyline',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.ownerUsername} invited you to collaborate on "${details.storylineTitle}"`,
      url: storylineUrl(details.storylineId as number),
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          sc."userId",
          sc."storylineId",
          jsonb_build_object(
            'storylineId', s.id,
            'storylineTitle', s.title,
            'ownerId', s."userId",
            'ownerUsername', u.username
          ) as "details"
        FROM "StorylineCollaborator" sc
        JOIN "Storyline" s ON s.id = sc."storylineId"
        JOIN "User" u ON u.id = s."userId"
        WHERE sc."acceptedAt" IS NULL
          AND sc."createdAt" > '${lastSent}'
          AND NOT s."tosViolation"
          AND ${notBlockedBetween('sc."userId"', 's."userId"')}
      )
      SELECT
        CONCAT('storyline-collaborator-invited:',"storylineId",':',"userId") "key",
        "userId",
        'storyline-collaborator-invited' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'storyline-collaborator-invited')
    `,
  },
  /**
   * Sent once chapter 1 exists, so a titled but empty story pings nobody: the watermark reads
   * chapter 1's creation, not the storyline's. Keyed per storyline, so it fires once.
   */
  'storyline-spark-started': {
    displayName: 'Someone started a story from your image',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.ownerUsername} started a story from your image: "${details.storylineTitle}"`,
      url: storylineUrl(details.storylineId as number),
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          i."userId",
          s.id "storylineId",
          jsonb_build_object(
            'storylineId', s.id,
            'storylineTitle', s.title,
            'imageId', i.id,
            'ownerId', s."userId",
            'ownerUsername', u.username
          ) as "details"
        FROM "Storyline" s
        JOIN "StorylineChapter" c ON c."storylineId" = s.id AND c.depth = 0
        JOIN "Image" i ON i.id = s."sparkImageId"
        JOIN "User" u ON u.id = s."userId"
        WHERE s."sparkImageId" IS NOT NULL
          AND c."createdAt" > '${lastSent}'
          AND c."removedAt" IS NULL
          AND i."userId" <> s."userId"
          AND NOT s."tosViolation"
          AND NOT i."tosViolation"
          AND ${notBlockedBetween('i."userId"', 's."userId"')}
      )
      SELECT
        CONCAT('storyline-spark-started:',"storylineId") "key",
        "userId",
        'storyline-spark-started' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'storyline-spark-started')
    `,
  },
});

/**
 * Sent where it happens (`storyline-publish.service`), not by a query. About the owner's own
 * storyline, so it names nobody and stays out of the placement avatar fetcher.
 */
export const storylineOwnerNotifications = createNotificationProcessor({
  'storyline-ceiling-raised': {
    displayName: 'Your storyline rating was raised to fit its first chapter',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `"${details.storylineTitle}" now allows up to ${
        browsingLevelLabels[details.maxNsfwLevel as keyof typeof browsingLevelLabels] ?? '?'
      }, the rating of its first chapter`,
      url: storylineUrl(details.storylineId as number),
    }),
  },
});

export const STORYLINE_CHAPTER_ADDED_TYPE = 'storyline-chapter-added';

/**
 * New chapters for a storyline's followers, within each follower's scope (`StorylineFollowScope`):
 * Canon is a chapter on the main path when this runs, Endorsed adds a chapter by the owner or a
 * collaborator accepted when this runs, Everything is any. A chapter that joins the main path later
 * (an insert, a rejoin) is past the window by then and is not announced.
 *
 * A chapter is live as the Recently updated sort reads it: not removed, its post published and not
 * taken down, its author not banned or deleted; it counts from when it went out. Only for a
 * storyline a follower may read as a whole: not taken down (by a moderator or the title scan),
 * chapter 1 shown, the owner's account standing, and the story's level within the follower's
 * browsing level, so the title is never sent to someone the feed would not show it to.
 *
 * Keyed per storyline, follower and hour of sending: the job runs every minute, each run in the
 * same hour reproduces the key, and the worker does not deliver a key twice. So a burst sends one,
 * and the message names no count, which later chapters in the hour would make stale.
 */
export function storylineChapterAddedQuery({ lastSent }: { lastSent: string }): string {
  return `
      WITH RECURSIVE fresh AS (
        SELECT c.id, c."storylineId", c."userId" "authorId"
        FROM "StorylineChapter" c
        JOIN "Post" p ON p.id = c."postId"
        JOIN "User" a ON a.id = p."userId"
        WHERE c.depth > 0
          AND c."removedAt" IS NULL
          AND NOT p."tosViolation"
          AND p."publishedAt" <= now()
          AND a."bannedAt" IS NULL AND a."deletedAt" IS NULL
          AND GREATEST(c."createdAt", p."publishedAt") > '${lastSent}'
          -- Against cursor drift after an outage or on a fresh database.
          AND GREATEST(c."createdAt", p."publishedAt") > now() - interval '7 days'
      ),
      visible AS (
        SELECT s.id, s.title, s."userId" "ownerId", ${storyLevelText({ st: 's', rp: 'rp' })} "level"
        FROM "Storyline" s
        JOIN "User" o ON o.id = s."userId"
        JOIN "StorylineChapter" rc ON rc."storylineId" = s.id AND rc.depth = 0
        JOIN "Post" rp ON rp.id = rc."postId"
        JOIN "User" ru ON ru.id = rp."userId"
        WHERE s.id IN (SELECT "storylineId" FROM fresh)
          AND NOT s."tosViolation"
          AND o."bannedAt" IS NULL AND o."deletedAt" IS NULL
          AND ${storylineRootVisibleText({ rc: 'rc', rp: 'rp', ru: 'ru' })}
      ),
      main AS (
        SELECT rc.id, 1 step FROM "StorylineChapter" rc
        WHERE rc.depth = 0 AND rc."storylineId" IN (SELECT id FROM visible)
        UNION ALL
        SELECT e."chapterId", main.step + 1 FROM main
        JOIN "StorylineChapterEdge" e ON e."parentChapterId" = main.id AND e.canon
        WHERE main.step < 100000
      ),
      data AS (
        SELECT f."userId", v.id "storylineId", v.title
        FROM "StorylineFollow" f
        JOIN visible v ON v.id = f."storylineId"
        JOIN fresh c ON c."storylineId" = f."storylineId"
        JOIN "User" fu ON fu.id = f."userId"
        WHERE c."authorId" <> f."userId"
          AND fu."bannedAt" IS NULL AND fu."deletedAt" IS NULL
          AND (v."level" & fu."browsingLevel") <> 0
          AND (
            f.scope = 'Everything'
            OR c.id IN (SELECT id FROM main)
            OR (f.scope = 'Endorsed' AND (c."authorId" = v."ownerId" OR EXISTS (
              SELECT 1 FROM "StorylineCollaborator" sc
              WHERE sc."storylineId" = c."storylineId" AND sc."userId" = c."authorId"
                AND sc."acceptedAt" IS NOT NULL
            )))
          )
          AND ${notBlockedBetween('f."userId"', 'c."authorId"')}
          AND ${notBlockedBetween('f."userId"', 'v."ownerId"')}
        GROUP BY f."userId", v.id, v.title
      )
      SELECT
        CONCAT('${STORYLINE_CHAPTER_ADDED_TYPE}:', "storylineId", ':', "userId", ':',
          to_char(date_trunc('hour', now()), 'YYYYMMDDHH24')) "key",
        "userId",
        '${STORYLINE_CHAPTER_ADDED_TYPE}' "type",
        jsonb_build_object('storylineId', "storylineId", 'storylineTitle', title) "details"
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = '${STORYLINE_CHAPTER_ADDED_TYPE}')
    `;
}

/** Kept apart from `storylineNotifications`, whose types the placement detail fetcher reads. */
export const storylineFollowNotifications = createNotificationProcessor({
  [STORYLINE_CHAPTER_ADDED_TYPE]: {
    displayName: 'New chapters in storylines you follow',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `New chapters in "${details.storylineTitle}"`,
      url: storylineUrl(details.storylineId as number),
    }),
    prepareQuery: async ({ lastSent }) => storylineChapterAddedQuery({ lastSent }),
  },
});
