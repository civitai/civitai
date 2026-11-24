// A blob's scan rating (`NsfwLevel`), as users see it on civitai.com. `na` is unrated.

/** The site's ratings, mildest first. */
export const NSFW_RATINGS = ['pg', 'pg13', 'r', 'x', 'xxx'] as const;
export type NsfwRating = (typeof NSFW_RATINGS)[number];

const NSFW_LEVEL_LABELS: Record<NsfwRating, string> = {
  pg: 'PG',
  pg13: 'PG-13',
  r: 'R',
  x: 'X',
  xxx: 'XXX',
};

// The main app's `isMature` (src/shared/constants/orchestrator.constants.ts).
const MATURE_NSFW_LEVELS = new Set<string>(['r', 'x', 'xxx']);

/** `level` as one of the site's ratings, matched case-insensitively like the mature probe's header read. */
export function asNsfwRating(level: string | null | undefined): NsfwRating | undefined {
  const lower = level?.toLowerCase();
  return (NSFW_RATINGS as readonly string[]).includes(lower ?? '')
    ? (lower as NsfwRating)
    : undefined;
}

export function isMatureNsfwLevel(level: string | null | undefined): boolean {
  const rating = asNsfwRating(level);
  return !!rating && MATURE_NSFW_LEVELS.has(rating);
}

/** A scan rating as users see it on civitai.com; undefined when unrated (`na`) or unknown. */
export function nsfwLevelLabel(level: string | null | undefined): string | undefined {
  const rating = asNsfwRating(level);
  return rating && NSFW_LEVEL_LABELS[rating];
}

export interface RatingCount {
  rating: NsfwRating;
  label: string;
  count: number;
  mature: boolean;
}

/** How many of `levels` carry each rating, mildest first; ratings with none are left out. */
export function ratingBreakdown(levels: (string | null | undefined)[]): RatingCount[] {
  const counts = new Map<NsfwRating, number>();
  for (const level of levels) {
    const rating = asNsfwRating(level);
    if (rating) counts.set(rating, (counts.get(rating) ?? 0) + 1);
  }
  return NSFW_RATINGS.filter((r) => counts.has(r)).map((rating) => ({
    rating,
    label: NSFW_LEVEL_LABELS[rating],
    count: counts.get(rating)!,
    mature: MATURE_NSFW_LEVELS.has(rating),
  }));
}
