export const CREATOR_JOURNEY_HREF = '/creators/journey';
export const CREATOR_SHOWCASE_HREF = '/creators/showcase';

/** CDN art for a hidden achievement not yet found: a gunmetal hexagon with a "?". */
export const HIDDEN_ACHIEVEMENT_PLACEHOLDER = '697cac26-7f27-4205-8a3c-886d31e17153';

/** The account score card, where the "how Creator Score is earned" explainer lives. */
export const CREATOR_SCORE_EXPLAINER_HREF = '/user/account#creator-score';

/** How long after a creator's first publish its one-time card is still offered. */
export const FIRST_PUBLISH_CARD_DAYS = 14;

/**
 * Every Creator Score tier, lowest first. A tier's milestone key is `score:<slug>`, and the grant
 * registry is built from this list, so a slug is permanent: renaming one re-grants everyone. Accents
 * are sampled from each tier's enamel plate, so glows and bars match the art.
 */
export const SCORE_TIERS = [
  { slug: 'spark', accent: '#c92a2a' },
  { slug: 'kindle', accent: '#d9480f' },
  { slug: 'flame', accent: '#f76707' },
  { slug: 'blaze', accent: '#f59f00' },
  { slug: 'beacon', accent: '#e8b923' },
  { slug: 'nova', accent: '#3b5bdb' },
  { slug: 'star', accent: '#4dabf7' },
  { slug: 'supernova', accent: '#ae3ec9' },
  { slug: 'legend', accent: '#e9c46a' },
] as const;

export type ScoreTierSlug = (typeof SCORE_TIERS)[number]['slug'];

export const scoreTierKey = (slug: ScoreTierSlug) => `score:${slug}` as const;

export function parseScoreTierSlug(value: unknown): ScoreTierSlug | null {
  return SCORE_TIERS.find((tier) => tier.slug === value)?.slug ?? null;
}

/** The tier slug of a milestone key, or null when the key is not a score tier. */
export const scoreTierSlugFromKey = (key: string) =>
  SCORE_TIERS.find((tier) => scoreTierKey(tier.slug) === key)?.slug ?? null;

/**
 * Each achievement track's title and accent, shared by the journey page and the share card. Special
 * achievements (track `hidden`) take SPECIAL_ACCENT.
 */
export const ACHIEVEMENT_TRACK_STYLES = {
  create: { title: 'Create', accent: '#12b886' },
  reach: { title: 'Reach', accent: '#f59f00' },
  earn: { title: 'Earn', accent: '#7950f2' },
  community: { title: 'Community', accent: '#228be6' },
  compete: { title: 'Compete', accent: '#fa5252' },
} as const;

export const SPECIAL_ACCENT = '#7950f2';

/**
 * A shared special achievement stays secret (decided with Justin): its card and share text name no
 * achievement and give no hint, as a visitor to the profile sees it masked too.
 */
export const SPECIAL_SHARE_NAME = 'Unlocked a secret';
export const SPECIAL_SHARE_LINE = 'What it takes stays hidden. Can you find it?';
export const SPECIAL_SHARE_TITLE = 'I unlocked a secret achievement on Civitai';

// A special's key is random (`hidden:vwjxua`), so a link naming one gives away nothing about its rule.
const ACHIEVEMENT_SHARE_KEY = /^(?:create|reach|earn|community|compete|hidden):[a-z0-9-]{1,40}$/;

/**
 * What a share link names: a score tier by its slug (`supernova`, the form links already in the wild
 * use) or an achievement by its milestone key (`reach:downloads-10000`). Null for anything else.
 */
export function parseMilestoneShareToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return parseScoreTierSlug(value) ?? (ACHIEVEMENT_SHARE_KEY.test(value) ? value : null);
}

/** The share token for a milestone key: a tier's slug, or the key itself. */
export const milestoneShareToken = (key: string): string => scoreTierSlugFromKey(key) ?? key;

/** The milestone key a share token names. */
export function milestoneKeyOfShareToken(token: string) {
  const slug = parseScoreTierSlug(token);
  return slug ? scoreTierKey(slug) : token;
}

/** A milestone share card's id, `<userId>.<token>`, e.g. `42.supernova` or `42.reach:downloads-10000`. */
export const milestoneShareId = (userId: number, token: string) => `${userId}.${token}`;

/** The profile link whose preview swaps to this milestone's card. */
export const milestoneShareHref = (username: string, token: string) =>
  `/user/${encodeURIComponent(username)}?milestone=${token}`;

/**
 * Where a visitor who opened a shared milestone link goes: the Achievements tab with that milestone
 * picked out. Null leaves them on the profile. The share link itself stays on the profile, whose server
 * render carries the milestone's og:image, and crawlers never follow this client-side hop.
 */
export function milestoneLandingHref({
  username,
  milestone,
  shareable,
  journeyOn,
}: {
  username: string;
  milestone: string | null;
  shareable: boolean | undefined;
  journeyOn: boolean;
}) {
  if (!milestone || !shareable || !journeyOn) return null;
  return `/user/${encodeURIComponent(username)}/achievements?milestone=${milestone}`;
}

/** A profile's og:image endpoint for `?milestone=`. Undefined keeps the profile's own preview. */
export function milestoneOgEndpoint(
  userId: number,
  milestone: string | null,
  shareable: boolean | undefined
) {
  return milestone && shareable
    ? `/api/og?type=milestone&id=${milestoneShareId(userId, milestone)}`
    : undefined;
}

export function parseMilestoneShareId(raw: string) {
  const match = /^(\d{1,10})\.(.{1,60})$/.exec(raw);
  if (!match) return null;
  const userId = Number(match[1]);
  const milestone = parseMilestoneShareToken(match[2]);
  return userId > 0 && userId <= 2_147_483_647 && milestone ? { userId, milestone } : null;
}
