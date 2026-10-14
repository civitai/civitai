import { CREATOR_PROGRAM_MIN_CREATOR_SCORE } from '@civitai/buzz';

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

// Hidden until a Blue Buzz fee rate is decided; `acceptsBlue` stays false until then.
export const SERVICE_BLUE_BUZZ_ENABLED = false;
