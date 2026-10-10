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

/** A milestone share card's id, `<userId>.<tierSlug>`, e.g. `42.supernova`. */
export const milestoneShareId = (userId: number, slug: ScoreTierSlug) => `${userId}.${slug}`;

/** The profile link whose preview swaps to this tier's card. */
export const milestoneShareHref = (username: string, slug: ScoreTierSlug) =>
  `/user/${encodeURIComponent(username)}?milestone=${slug}`;

/**
 * Where a visitor who opened a shared tier link goes: the Achievements tab with that tier picked
 * out. Null leaves them on the profile. The share link itself stays on the profile, whose server
 * render carries the tier's og:image, and crawlers never follow this client-side hop.
 */
export function milestoneLandingHref({
  username,
  milestone,
  shareable,
  journeyOn,
}: {
  username: string;
  milestone: ScoreTierSlug | null;
  shareable: boolean | undefined;
  journeyOn: boolean;
}) {
  if (!milestone || !shareable || !journeyOn) return null;
  return `/user/${encodeURIComponent(username)}/achievements?milestone=${milestone}`;
}

/** A profile's og:image endpoint for `?milestone=`. Undefined keeps the profile's own preview. */
export function milestoneOgEndpoint(
  userId: number,
  milestone: ScoreTierSlug | null,
  shareable: boolean | undefined
) {
  return milestone && shareable
    ? `/api/og?type=milestone&id=${milestoneShareId(userId, milestone)}`
    : undefined;
}

export function parseMilestoneShareId(raw: string) {
  const match = /^(\d{1,10})\.([a-z]+)$/.exec(raw);
  if (!match) return null;
  const userId = Number(match[1]);
  const slug = parseScoreTierSlug(match[2]);
  return userId > 0 && userId <= 2_147_483_647 && slug ? { userId, slug } : null;
}
