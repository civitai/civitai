import { CREATOR_PROGRAM_MIN_CREATOR_SCORE } from '@civitai/buzz';
import { NsfwLevel } from '~/server/common/enums';
import {
  isMatureServiceLevel,
  serviceRequestAllowed,
} from '~/shared/constants/creator-services.constants';

/** Selling services unlocks at Beacon, the same rung (and the same aggregate score) as the Creator Program. */
export const SERVICES_MIN_CREATOR_SCORE = CREATOR_PROGRAM_MIN_CREATOR_SCORE;

/** `KeyValue` row overriding SERVICES_MIN_CREATOR_SCORE without a deploy, as a positive whole number. */
export const SERVICES_MIN_CREATOR_SCORE_KEY = 'creator-services-min-creator-score';

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
 * The ratings this domain may show a seller of their own offerings. Decision (briony, 2026-10-15):
 * the SFW domain serves no mature content even to its owner, as with a user's own images there.
 */
export const servableServiceRatings = (servable: number) =>
  SERVICE_OFFERING_RATINGS.filter(
    (rating) => !isMatureServiceLevel(rating) || (rating & servable) !== 0
  );

/**
 * The mature ratings a viewer may see on a storefront: exactly the ones they may request
 * (`serviceRequestAllowed`, the rule the server enforces). Decision (briony, 2026-10-15): PG and
 * PG-13 offerings show to everyone, everywhere; filtering them by level would hide every default
 * (PG-13) offering from signed-out viewers, whose level is PG.
 */
export const visibleMatureServiceRatings = ({
  browsingLevel,
  servable,
}: {
  browsingLevel: number | undefined;
  servable: number;
}) =>
  SERVICE_OFFERING_RATINGS.filter(
    (rating) =>
      isMatureServiceLevel(rating) &&
      serviceRequestAllowed({
        maxNsfwLevel: rating,
        servableLevels: servable,
        consentLevels: browsingLevel ?? 0,
      })
  );
