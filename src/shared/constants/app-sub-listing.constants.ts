import type {
  ListingCard,
  StoreGridItem,
  SubListingCard,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  OFFSITE_CONTENT_RATING_LADDER,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';

/**
 * App Store sub-listings: the vocabulary shared by the write service, the store read path,
 * the moderator tab and the card. Client-safe (no server imports).
 *
 * The status and rating sets mirror the CHECKs in
 * `packages/civitai-db-schema/prisma/migrations/20261010120000_app_sub_listings/migration.sql`;
 * `app-sub-listing.constants.test.ts` parses that file and fails on drift.
 */

export const APP_SUB_LISTING_STATUSES = ['pending', 'approved', 'hidden', 'withdrawn'] as const;
export type AppSubListingStatus = (typeof APP_SUB_LISTING_STATUSES)[number];

/** Same five values, same order, as the listing rating ladder (ascending maturity). */
export const APP_SUB_LISTING_CONTENT_RATINGS = OFFSITE_CONTENT_RATING_LADDER;
export type AppSubListingContentRating = OffsiteRatingValue;

export const APP_SUB_LISTING_TITLE_MAX = 80;
export const APP_SUB_LISTING_TAGLINE_MAX = 140;
export const APP_SUB_LISTING_ITEM_KEY_MAX = 64;
export const APP_SUB_LISTING_SUB_PATH_MAX = 128;
export const APP_SUB_LISTING_REASON_MAX = 500;

/**
 * Letters, digits, `_` and `-`, in one to four `/`-separated segments of at most 64 chars.
 * Nothing that could change the origin or escape the parent's run route can match: no dots
 * (so no `..`), no `%`, `?`, `#`, `\`, `:` or empty segment. Byte-identical to the DB CHECK.
 */
export const APP_SUB_LISTING_SUB_PATH_RE = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,3}$/;

export function isValidSubListingSubPath(value: string): boolean {
  return value.length <= APP_SUB_LISTING_SUB_PATH_MAX && APP_SUB_LISTING_SUB_PATH_RE.test(value);
}

/** `asl_` + a 26-char Crockford ULID — the shape `newAppSubListingId` mints. */
export const APP_SUB_LISTING_ID_RE = /^asl_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isAppSubListingId(value: unknown): value is string {
  return typeof value === 'string' && APP_SUB_LISTING_ID_RE.test(value);
}

function ratingRank(rating: string | null | undefined): number {
  // NULL ranks with `g`: an unrated parent puts no floor under its children.
  if (!rating) return 0;
  return (APP_SUB_LISTING_CONTENT_RATINGS as readonly string[]).indexOf(rating.toLowerCase());
}

export function isAppSubListingContentRating(value: unknown): value is AppSubListingContentRating {
  return (
    typeof value === 'string' &&
    (APP_SUB_LISTING_CONTENT_RATINGS as readonly string[]).includes(value)
  );
}

/**
 * A child may be as mature as its parent or more, never less. An unset child rating inherits
 * the parent's (the card is shown under {@link effectiveSubListingRating}).
 */
export function isRatingAtLeastAsStrict(
  child: string | null | undefined,
  parent: string | null | undefined
): boolean {
  if (child == null) return true;
  const childRank = ratingRank(child);
  const parentRank = ratingRank(parent);
  return childRank >= 0 && parentRank >= 0 && childRank >= parentRank;
}

/**
 * The rating a sub-listing card is shown under: the stricter of parent and child. An unknown
 * stored value on either side wins (treated as the strictest), so a poison row can only ever
 * be over-rated.
 */
export function effectiveSubListingRating(
  parent: string | null | undefined,
  child: string | null | undefined
): string | null {
  const p = ratingRank(parent);
  const c = ratingRank(child);
  if (p < 0) return parent ?? null;
  if (c < 0) return child ?? null;
  if (!parent && !child) return null;
  return APP_SUB_LISTING_CONTENT_RATINGS[Math.max(p, c)];
}

/** The server-built link for a sub-listing. The client never receives a URL to trust. */
export function subListingRunHref(parentSlug: string, subPath: string, subListingId: string) {
  const path = subPath.split('/').map(encodeURIComponent).join('/');
  return `/apps/run/${encodeURIComponent(parentSlug)}/${path}?sl=${encodeURIComponent(
    subListingId
  )}`;
}

export function isSubListingCard(item: StoreGridItem): item is SubListingCard {
  return (item as SubListingCard).cardType === 'sub-listing';
}

/** The app cards of a store page, for a surface that renders `ListingCard`s only. */
export function onlyListingCards(items: readonly StoreGridItem[]): ListingCard[] {
  return items.filter((item): item is ListingCard => !isSubListingCard(item));
}
