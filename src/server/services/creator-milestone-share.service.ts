import { getEdgeUrl } from '~/client-utils/edge-url';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import { isCreatorJourneyOnFor } from '~/server/services/creator-journey-flag.service';
import {
  milestoneShowableUserSql,
  toUtcTimestamp,
} from '~/server/services/creator-milestone-exclusions';
import { achievedAtIsObserved } from '~/server/services/creator-milestone-grant.service';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { buildOgCoverEdgeUrl } from '~/server/utils/og-image-helpers';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import { SCORE_TIERS, scoreTierKey } from '~/shared/constants/creator-journey.constants';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { isBadgeShownOnProfile } from '~/shared/utils/badge-visibility';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';

export const AVATAR_SIZE = 96;
export const BADGE_SIZE = 320;

type ShareCardRow = {
  milestoneKey: string;
  username: string | null;
  isModerator: boolean;
  tierName: string;
  badgeId: number | null;
  badgeUrl: string | null;
  achievedAt: Date;
  seenAt: Date | null;
  achievedMonth: string;
  privacySettings: PrivacySettingsSchema | null;
  pictureUrl: string | null;
  pictureType: MediaType | null;
  pictureNsfwLevel: number | null;
};

type ShareOptions = { pg?: AugmentedPool; now?: Date };

/**
 * The crossings behind a creator's tier share cards: the one rule for whether a card renders. The card
 * is served unauthenticated, so the owner's flag stands in for the viewer's. A creator who opted out of
 * the showcase still gets one: they post it about themselves.
 */
async function getShareableMilestones(
  { userId, slugs }: { userId: number; slugs: readonly ScoreTierSlug[] },
  { pg = pgDbRead, now = new Date() }: ShareOptions = {}
) {
  const excludedUserIds = await getMetricExcludedUserIdsOrThrow();
  // The picture takes the same moderation filter as every other og card's image. `User.image` is never
  // a fallback: it is unscanned, and fetching it would send this server to any host a user stored.
  const query = await pg.cancellableQuery<ShareCardRow>(
    `
    SELECT ucm."milestoneKey", u.username, u."isModerator", m.name AS "tierName",
      m."cosmeticId" AS "badgeId", c.data ->> 'url' AS "badgeUrl", ucm."achievedAt", ucm."seenAt",
      p."privacySettings", to_char(ucm."achievedAt", 'YYYY-MM') AS "achievedMonth",
      i.url AS "pictureUrl", i.type AS "pictureType", i."nsfwLevel" AS "pictureNsfwLevel"
    FROM "UserCreatorMilestone" ucm
    JOIN "CreatorMilestone" m ON m.key = ucm."milestoneKey"
    JOIN "User" u ON u.id = ucm."userId"
    LEFT JOIN "Cosmetic" c ON c.id = m."cosmeticId"
    LEFT JOIN "UserProfile" p ON p."userId" = u.id
    LEFT JOIN "Image" i ON i.id = u."profilePictureId"
      AND i.ingestion = 'Scanned' AND NOT i."tosViolation" AND i."needsReview" IS NULL
    WHERE ucm."userId" = $1 AND ucm."milestoneKey" = ANY($2::text[])
      AND ${milestoneShowableUserSql('u', { excludedUserIds: '$3', now: '$4' })}
    `,
    [userId, slugs.map(scoreTierKey), excludedUserIds, toUtcTimestamp(now)]
  );
  const rows = (await query.result()).filter(
    // A backfilled grant was never seen crossing, so it has no moment to celebrate.
    (row) => achievedAtIsObserved(row) && isBadgeShownOnProfile(row.privacySettings, row.badgeId)
  );
  const [row] = rows;
  if (!row) return [];
  if (!(await isCreatorJourneyOnFor({ id: userId, isModerator: row.isModerator }))) return [];
  return rows;
}

/** The crossing behind one tier's share card, or null when the card must not render. */
async function getShareableMilestone(
  { userId, slug }: { userId: number; slug: ScoreTierSlug },
  options?: ShareOptions
) {
  const [row] = await getShareableMilestones({ userId, slugs: [slug] }, options);
  return row ?? null;
}

/** Every tier whose share card renders for this creator, lowest first, in one read. */
export async function getShareableTierSlugs(userId: number, options?: ShareOptions) {
  const slugs = SCORE_TIERS.map((tier) => tier.slug);
  const shareable = new Set(
    (await getShareableMilestones({ userId, slugs }, options)).map((row) => row.milestoneKey)
  );
  return slugs.filter((slug) => shareable.has(scoreTierKey(slug)));
}

/** Whether a profile link should swap its preview to this tier's card. No swap keeps the profile's own. */
export async function isMilestoneShareable(...args: Parameters<typeof getShareableMilestone>) {
  return !!(await getShareableMilestone(...args));
}

/** The link-preview card for a creator reaching a score tier, or null when it must not render. */
export async function getMilestoneShareCard(...args: Parameters<typeof getShareableMilestone>) {
  const row = await getShareableMilestone(...args);
  if (!row) return null;
  const [{ slug }] = args;
  const { pictureUrl, pictureType, pictureNsfwLevel } = row;
  return {
    username: row.username ?? 'Creator',
    avatarUrl:
      pictureUrl && pictureType && getIsSafeBrowsingLevel(pictureNsfwLevel ?? 0)
        ? buildOgCoverEdgeUrl(
            { url: pictureUrl, type: pictureType },
            { width: AVATAR_SIZE, height: AVATAR_SIZE }
          )
        : null,
    tierName: row.tierName,
    accent: SCORE_TIERS.find((tier) => tier.slug === slug)?.accent ?? null,
    badgeUrl: row.badgeUrl ? getEdgeUrl(row.badgeUrl, { width: BADGE_SIZE, anim: false }) : null,
    // From the column's own text, so no zone can shift the month.
    reached: formatDate(`${row.achievedMonth}-01`, 'MMMM YYYY', true),
  };
}
