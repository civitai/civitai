import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { storylineUrl } from '~/components/Storyline/storyline-routes';

/**
 * Continuations are placements on the `storyline` surface: the target is the chapter post being
 * continued, `data.postId` is the post offered as the next chapter, the owner is the storyline's
 * owner and the placer is the contributor.
 *
 * Three types rather than one with branches, so each can be muted on its own. None of them says
 * anything about Buzz: a continuation may be priced at zero, and a decline's fee and refund settle
 * after the row is resolved, so a money sentence could be false when it is read.
 */
function continuationRows({ named }: { named: 'placer' | 'owner' }) {
  const namedColumn = named === 'placer' ? 'p."placerId"' : 'p."ownerId"';
  return `
    FROM "Placement" p
    JOIN "StorylineChapter" c ON c."postId" = p."targetId"
    JOIN "Storyline" s ON s.id = c."storylineId"
    JOIN "User" u ON u.id = ${namedColumn}
    WHERE p.surface = 'storyline'
      AND p."targetType" = 'post'
      AND NOT s."tosViolation"
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
        'ownerUsername', u.username
      ) as "details"
    ${continuationRows({ named: 'owner' })}
      AND p.status = '${status}'
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
      url: storylineUrl(details.storylineId as number),
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
          AND p."createdAt" > '${lastSent}'
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
      message: `${details.ownerUsername} added your chapter to "${details.storylineTitle}"`,
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
