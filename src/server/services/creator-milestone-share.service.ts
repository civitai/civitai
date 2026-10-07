import { getEdgeUrl } from '~/client-utils/edge-url';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import { isCreatorJourneyOnFor } from '~/server/services/creator-journey-flag.service';
import { milestoneShowableUserSql } from '~/server/services/creator-milestone-exclusions';
import { achievedAtIsObserved } from '~/server/services/creator-milestone-grant.service';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { getProfilePicturesForUsers } from '~/server/services/user.service';
import { buildOgCoverEdgeUrl } from '~/server/utils/og-image-helpers';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import { SCORE_TIERS, scoreTierKey } from '~/shared/constants/creator-journey.constants';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { isBadgeShownOnProfile } from '~/shared/utils/badge-visibility';
import type { MediaType } from '~/shared/utils/prisma/enums';

export const AVATAR_SIZE = 96;
export const BADGE_SIZE = 320;

type ShareCardRow = {
  username: string | null;
  image: string | null;
  isModerator: boolean;
  tierName: string;
  badgeId: number | null;
  badgeUrl: string | null;
  achievedAt: Date;
  seenAt: Date | null;
  achievedMonth: string;
  privacySettings: PrivacySettingsSchema | null;
};

/** `YYYY-MM` as "October 2026". Formatted from the column's own text, so no zone can shift it. */
function formatUtcMonth(month: string) {
  const [year, monthIndex] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthIndex - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** `timestamp(3)` columns hold UTC wall time, so compare against a zoneless UTC literal. */
const toUtcTimestamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');

/**
 * The link-preview card for a creator reaching a score tier, or null when it must not render. It is
 * served unauthenticated, so the owner's flag stands in for the viewer's. A creator who opted out of
 * the showcase still gets one: they post it about themselves.
 */
export async function getMilestoneShareCard(
  { userId, slug }: { userId: number; slug: ScoreTierSlug },
  { pg = pgDbRead, now = new Date() }: { pg?: AugmentedPool; now?: Date } = {}
) {
  const excludedUserIds = await getMetricExcludedUserIdsOrThrow();
  const query = await pg.cancellableQuery<ShareCardRow>(
    `
    SELECT u.username, u.image, u."isModerator", m.name AS "tierName", m."cosmeticId" AS "badgeId",
      c.data ->> 'url' AS "badgeUrl", ucm."achievedAt", ucm."seenAt", p."privacySettings",
      to_char(ucm."achievedAt", 'YYYY-MM') AS "achievedMonth"
    FROM "UserCreatorMilestone" ucm
    JOIN "CreatorMilestone" m ON m.key = ucm."milestoneKey"
    JOIN "User" u ON u.id = ucm."userId"
    LEFT JOIN "Cosmetic" c ON c.id = m."cosmeticId"
    LEFT JOIN "UserProfile" p ON p."userId" = u.id
    WHERE ucm."userId" = $1 AND ucm."milestoneKey" = $2
      AND ${milestoneShowableUserSql('u', { excludedUserIds: '$3', now: '$4' })}
    `,
    [userId, scoreTierKey(slug), excludedUserIds, toUtcTimestamp(now)]
  );
  const [row] = await query.result();
  // A backfilled grant was never seen crossing, so it has no moment to celebrate.
  if (!row || !achievedAtIsObserved(row)) return null;
  if (!isBadgeShownOnProfile(row.privacySettings, row.badgeId)) return null;
  if (!(await isCreatorJourneyOnFor({ id: userId, isModerator: row.isModerator }))) return null;

  const picture = (await getProfilePicturesForUsers([userId]))[userId] as
    | { url: string; nsfwLevel: number; type: MediaType }
    | undefined;
  return {
    username: row.username ?? 'Creator',
    avatarUrl:
      picture && getIsSafeBrowsingLevel(picture.nsfwLevel)
        ? buildOgCoverEdgeUrl(picture, { width: AVATAR_SIZE, height: AVATAR_SIZE })
        : row.image?.startsWith('http')
        ? row.image
        : null,
    tierName: row.tierName,
    accent: SCORE_TIERS.find((tier) => tier.slug === slug)?.accent ?? null,
    badgeUrl: row.badgeUrl ? getEdgeUrl(row.badgeUrl, { width: BADGE_SIZE, anim: false }) : null,
    reached: formatUtcMonth(row.achievedMonth),
  };
}
