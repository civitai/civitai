import { CREATOR_PROGRAM_MIN_CREATOR_SCORE } from '@civitai/buzz';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

/** Selling services unlocks at Beacon, the same rung (and the same aggregate score) as the Creator Program. */
export const SERVICES_MIN_CREATOR_SCORE = CREATOR_PROGRAM_MIN_CREATOR_SCORE;

// Product defaults, not DB constraints: the DB only checks price > 0, days > 0, revisions >= 0.
export const SERVICE_PRICE_MIN = 100;
export const SERVICE_PRICE_MAX = 1_000_000;
export const SERVICE_DELIVERY_DAYS_MIN = 1;
export const SERVICE_DELIVERY_DAYS_MAX = 60;
export const SERVICE_REVISIONS_MAX = 10;
export const SERVICE_OPEN_DEALS_MIN = 1;
export const SERVICE_OPEN_DEALS_MAX = 20;
export const SERVICE_TITLE_MIN = 3;
export const SERVICE_TITLE_MAX = 100;
export const SERVICE_DESCRIPTION_MAX = 2_000;
export const SERVICE_MAX_ACTIVE_OFFERINGS = 20;

/**
 * The ratings an offering can carry: one NsfwLevel bit, its ceiling. Never Blocked, never a mask
 * (the DB CHECK refuses both; the schema answers 400 before it gets there).
 */
export const SERVICE_OFFERING_RATINGS = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
] as const;
export const SERVICE_OFFERING_DEFAULT_RATING = NsfwLevel.PG13;

/**
 * Decision (briony, 2026-10-15): an offering rated PG or PG-13 is visible and requestable by
 * everyone, everywhere, as before ratings existed. Only a mature rating (R and up) is held to the
 * domain and the viewer's browsing level. Taking the level filter literally would hide every
 * default (PG-13) offering from signed-out viewers, whose level is PG.
 */
export const isMatureServiceRating = (rating: number) => rating > NsfwLevel.PG13;

/** The mature ratings a viewer may see: in both their browsing level and the domain's. */
export const visibleMatureServiceRatings = ({
  browsingLevel,
  servable,
}: {
  browsingLevel: number | undefined;
  servable: number;
}) =>
  SERVICE_OFFERING_RATINGS.filter(
    (rating) =>
      isMatureServiceRating(rating) &&
      Flags.intersects(rating, browsingLevel ?? 0) &&
      Flags.intersects(rating, servable)
  );
