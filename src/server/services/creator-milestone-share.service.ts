import { getEdgeUrl } from '~/client-utils/edge-url';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import type { CosmeticOffsets } from '~/server/schema/creator-shop.schema';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import { isCreatorJourneyOnFor } from '~/server/services/creator-journey-flag.service';
import {
  milestoneShowableUserSql,
  toUtcTimestamp,
} from '~/server/services/creator-milestone-exclusions';
import { achievedAtIsObserved } from '~/server/services/creator-milestone-grant.service';
import type { ActivityMeasure } from '~/server/services/creator-milestone-registry';
import {
  activityMeasureOf,
  creatorMilestoneRegistry,
} from '~/server/services/creator-milestone-registry';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
import { buildOgCoverEdgeUrl } from '~/server/utils/og-image-helpers';
import {
  ACHIEVEMENT_TRACK_STYLES,
  milestoneKeyOfShareToken,
  SCORE_TIERS,
  scoreTierSlugFromKey,
  SPECIAL_ACCENT,
  SPECIAL_SHARE_LINE,
  SPECIAL_SHARE_NAME,
} from '~/shared/constants/creator-journey.constants';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { isBadgeShownOnProfile } from '~/shared/utils/badge-visibility';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

export const AVATAR_SIZE = 96;
export const BADGE_SIZE = 340;
const PROFILE_BADGE_SIZE = 64;

type ShareStateRow = {
  milestoneKey: string;
  /** A secret milestone: the profile masks it from visitors, so its card and share text do too. */
  hidden: boolean;
  isModerator: boolean;
  badgeId: number | null;
  privacySettings: PrivacySettingsSchema | null;
};

type ShareCardRow = ShareStateRow & {
  username: string | null;
  name: string;
  track: string;
  threshold: number | null;
  badgeUrl: string | null;
  achievedAt: Date;
  seenAt: Date | null;
  achievedMonth: string;
  pictureUrl: string | null;
  pictureType: MediaType | null;
  pictureNsfwLevel: number | null;
  decorationData: ProfileDecorationData | null;
  profileBadgeUrl: string | null;
};

type ProfileDecorationData = { url?: string; offset?: string; offsets?: CosmeticOffsets };

type ShareOptions = { pg?: AugmentedPool; now?: Date };

/** A cosmetic the creator wears on their profile (not one equipped to a piece of content), as their avatar shows it. */
const equippedProfileCosmeticSql = (type: 'ProfileDecoration' | 'Badge', column: string) => `
  SELECT ${column} FROM "UserCosmetic" puc
  JOIN "Cosmetic" pc ON pc.id = puc."cosmeticId"
  WHERE puc."userId" = u.id AND puc."equippedAt" IS NOT NULL AND puc."equippedToId" IS NULL
    AND pc.type = '${type}'
  ORDER BY puc."equippedAt" DESC LIMIT 1`;

const STATE_COLUMNS = `ucm."milestoneKey", m.hidden, u."isModerator", m."cosmeticId" AS "badgeId",
  p."privacySettings"`;

// The picture takes the same moderation filter as every other og card's image. `User.image` is never
// a fallback: it is unscanned, and fetching it would send this server to any host a user stored.
const CARD_COLUMNS = `${STATE_COLUMNS}, u.username, m.name, m.track, m.threshold,
  c.data ->> 'url' AS "badgeUrl", ucm."achievedAt", ucm."seenAt",
  to_char(ucm."achievedAt", 'YYYY-MM') AS "achievedMonth",
  i.url AS "pictureUrl", i.type AS "pictureType", i."nsfwLevel" AS "pictureNsfwLevel",
  (${equippedProfileCosmeticSql('ProfileDecoration', 'pc.data')}) AS "decorationData",
  (${equippedProfileCosmeticSql('Badge', "pc.data ->> 'url'")}) AS "profileBadgeUrl"`;

const CARD_JOINS = `
  LEFT JOIN "Cosmetic" c ON c.id = m."cosmeticId"
  LEFT JOIN "Image" i ON i.id = u."profilePictureId"
    AND i.ingestion = 'Scanned' AND NOT i."tosViolation" AND i."needsReview" IS NULL`;

/**
 * A creator's crossings that may be put on show, each with whether the owner shows its badge on their
 * profile. Showable means the owner is in good standing and their flag is on: the card is served
 * unauthenticated, so the owner's flag stands in for the viewer's. A creator who opted out of the
 * showcase still gets cards: they post them about themselves. `keys` narrows to those milestones.
 */
async function getShowableMilestones<Row extends ShareStateRow>(
  { userId, keys, card }: { userId: number; keys?: readonly string[]; card: boolean },
  { pg = pgDbRead, now = new Date() }: ShareOptions = {}
) {
  const excludedUserIds = await getMetricExcludedUserIdsOrThrow();
  const query = await pg.cancellableQuery<Row>(
    `
    SELECT ${card ? CARD_COLUMNS : STATE_COLUMNS}
    FROM "UserCreatorMilestone" ucm
    JOIN "CreatorMilestone" m ON m.key = ucm."milestoneKey"
    JOIN "User" u ON u.id = ucm."userId"
    LEFT JOIN "UserProfile" p ON p."userId" = u.id
    ${card ? CARD_JOINS : ''}
    WHERE ucm."userId" = $1 AND ($2::text[] IS NULL OR ucm."milestoneKey" = ANY($2::text[]))
      AND ${milestoneShowableUserSql('u', { excludedUserIds: '$3', now: '$4' })}
    ORDER BY m."sortOrder", ucm."milestoneKey"
    `,
    [userId, keys ?? null, excludedUserIds, toUtcTimestamp(now)]
  );
  const rows = await query.result();
  const [row] = rows;
  if (!row) return [];
  if (!(await isCreatorJourneyOnFor({ id: userId, isModerator: row.isModerator }))) return [];
  return rows.map((row) => ({
    ...row,
    shownOnProfile: isBadgeShownOnProfile(row.privacySettings, row.badgeId),
  }));
}

/**
 * The crossing behind one milestone's share card, or null when the card must not render: the one rule
 * for whether a card renders. A backfilled grant shares too: at launch every tier held was backfilled,
 * so filtering them out offered nobody a card.
 */
async function getShareableMilestone<Row extends ShareStateRow = ShareCardRow>(
  { userId, milestone }: { userId: number; milestone: string },
  options?: ShareOptions,
  card = true
) {
  const [row] = await getShowableMilestones<Row>(
    { userId, keys: [milestoneKeyOfShareToken(milestone)], card },
    options
  );
  return row?.shownOnProfile ? row : null;
}

/**
 * For the owner, in one read: the milestones whose share card renders, the earned ones that would
 * share but for their badge being hidden on the profile (they get the unhide hint), and which of the
 * shareable ones are secret (their share text is masked, as their card is).
 */
export async function getMilestoneShareStates(userId: number, options?: ShareOptions) {
  const rows = await getShowableMilestones<ShareStateRow>({ userId, card: false }, options);
  const shown = rows.filter((row) => row.shownOnProfile);
  return {
    shareable: shown.map((row) => row.milestoneKey),
    hiddenOnProfile: rows.filter((row) => !row.shownOnProfile).map((row) => row.milestoneKey),
    secret: shown.filter((row) => row.hidden).map((row) => row.milestoneKey),
  };
}

/** Whether a profile link should swap its preview to this milestone's card. No swap keeps the profile's own. */
export async function isMilestoneShareable(
  input: { userId: number; milestone: string },
  options?: ShareOptions
) {
  return !!(await getShareableMilestone<ShareStateRow>(input, options, false));
}

const n = numberWithCommas;

/** What the creator did, for strangers: the stored descriptions speak to the owner ("your models"). */
const measureLines: Record<ActivityMeasure, (threshold: number) => string> = {
  models: (t) => (t === 1 ? 'Published a first model' : `Published ${n(t)} models`),
  articles: (t) => (t === 1 ? 'Published a first article' : `Published ${n(t)} articles`),
  downloads: (t) => `One model reached ${n(t)} downloads`,
  followers: (t) => `Reached ${n(t)} followers`,
  reactions: (t) => `Reached ${n(t)} reactions`,
  revenue: (t) => `${n(t)} Buzz in shop sales`,
  votes: (t) => `Cast ${n(t)} Crucible votes`,
  wins: (t) =>
    t === 1 ? 'Won a first challenge or Crucible' : `Won ${n(t)} challenges and Crucibles`,
};

/** An achievement's line under its name on the share card. Null for tiers and specials. */
export function achievementShareLine(key: string, threshold: number | null) {
  const entry = creatorMilestoneRegistry[key];
  const measure = entry ? activityMeasureOf(entry) : null;
  return measure && threshold != null ? measureLines[measure](threshold) : null;
}

/** The small capitals above the name, the accent the card is lit with, and the verb before its month. */
function cardStyle(key: string, track: string, secret: boolean) {
  if (secret)
    return { eyebrow: 'Special Achievement', accent: SPECIAL_ACCENT, reachedVerb: 'Earned' };
  const slug = scoreTierSlugFromKey(key);
  if (slug)
    return {
      eyebrow: 'Creator Score Tier',
      accent: SCORE_TIERS.find((tier) => tier.slug === slug)?.accent ?? null,
      reachedVerb: 'Reached',
    };
  const style = ACHIEVEMENT_TRACK_STYLES[track as keyof typeof ACHIEVEMENT_TRACK_STYLES];
  return {
    eyebrow: style ? `${style.title} Achievement` : 'Achievement',
    accent: style?.accent ?? null,
    reachedVerb: 'Earned',
  };
}

/** The link-preview card for a creator reaching a milestone, or null when it must not render. */
export async function getMilestoneShareCard(
  input: { userId: number; milestone: string },
  options?: ShareOptions
) {
  const row = await getShareableMilestone(input, options);
  if (!row) return null;
  const { pictureUrl, pictureType, pictureNsfwLevel, decorationData, profileBadgeUrl } = row;
  // The `hidden` column, the one the profile masks by, not the track or the key's prefix.
  const secret = row.hidden;
  return {
    username: row.username ?? 'Creator',
    avatarUrl:
      pictureUrl && pictureType && getIsSafeBrowsingLevel(pictureNsfwLevel ?? 0)
        ? buildOgCoverEdgeUrl(
            { url: pictureUrl, type: pictureType },
            { width: AVATAR_SIZE, height: AVATAR_SIZE }
          )
        : null,
    name: secret ? SPECIAL_SHARE_NAME : row.name,
    ...cardStyle(row.milestoneKey, row.track, secret),
    line: secret ? SPECIAL_SHARE_LINE : achievementShareLine(row.milestoneKey, row.threshold),
    // `optimized` is what keeps the art's transparency: a plain resize comes back as a JPEG.
    badgeUrl: row.badgeUrl
      ? getEdgeUrl(row.badgeUrl, { width: BADGE_SIZE, anim: false, optimized: true })
      : null,
    decoration: decorationData?.url
      ? {
          url: getEdgeUrl(decorationData.url, {
            width: AVATAR_SIZE * 2,
            anim: false,
            optimized: true,
          }),
          offset: decorationData.offset,
          offsets: decorationData.offsets,
        }
      : null,
    profileBadgeUrl: profileBadgeUrl
      ? getEdgeUrl(profileBadgeUrl, { width: PROFILE_BADGE_SIZE, anim: false, optimized: true })
      : null,
    // A backfilled grant's achievedAt is the backfill's own date, so the card names no month, as the
    // journey page shows none. The month comes from the column's own text, so no zone can shift it.
    reached: achievedAtIsObserved(row)
      ? formatDate(`${row.achievedMonth}-01`, 'MMMM YYYY', true)
      : null,
  };
}
