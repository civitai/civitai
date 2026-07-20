import * as z from 'zod';

import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';
import { APP_LISTING_STATUSES } from '~/server/services/blocks/app-listing-status.constants';

/**
 * App Store Listings (W13) — P2a UNIFIED STORE READ PATH schemas + public DTOs.
 *
 * These back the NEW `appListings.listAvailable` / `appListings.getAppDetail`
 * read procs that serve the unified `/apps` store over BOTH kinds (`onsite`
 * AppBlocks + `offsite` external/connect apps) from the durable `AppListing`
 * record. They MIRROR the existing AppBlock read path
 * (`blocks.listAvailable` / `blocks.getAppDetail` +
 * `subscription.schema.ts::AvailableBlock` / `PublicAppDetail`) so the two can't
 * drift, but read `AppListing` rather than `AppBlock`.
 *
 * DARK / parallel-run: nothing here is on the LIVE `/apps` surface yet (that
 * still reads the AppBlock path). The new procs live ALONGSIDE it behind the
 * SAME mod-segmented App Blocks flag; the UI switch + cutover are later PRs.
 *
 * SECURITY: every DTO below is a PUBLIC-FIELD ALLOWLIST (like `AvailableBlock` /
 * `PublicBlockManifest`). Internal fields (trustTier, raw iframe.src, OAuth
 * secrets, owner PII beyond the public creator chip, DB status) are NEVER shaped
 * in — a field can only leak if it is added here on purpose.
 */

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

/** Kind filter for the unified store: everything, on-site only, or off-site only. */
export const listingKindFilterSchema = z.enum(['all', 'onsite', 'offsite']);
export type ListingKindFilter = z.infer<typeof listingKindFilterSchema>;

/**
 * Store sort options:
 *   - `top-rated` (DEFAULT) — Bayesian-shrinkage on the recommend proportion
 *     (up / (up+down)) DESC; a few-review 100%-recommend app can't outrank a
 *     many-review 90% app, and 0-review apps sit mid-pack at the global mean
 *     recommend rate (mirrors the AppBlock `rating` sort, on a proportion
 *     instead of a 1..5 average). Ties fall back to install_count then id.
 *   - `popular`  — install_count DESC (from the AppListingMetric rollup).
 *   - `newest`   — created_at DESC.
 *   - `name`     — name ASC (case-insensitive).
 */
export const listingSortSchema = z.enum(['top-rated', 'popular', 'newest', 'name']);
export type ListingSort = z.infer<typeof listingSortSchema>;

export const listAppListingsSchema = z.object({
  kind: listingKindFilterSchema.default('all'),
  // Category filter validated against the single-source taxonomy const (shared
  // with the AppBlock path) so adding a category needs no schema migration.
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  sort: listingSortSchema.default('top-rated'),
  // Opaque keyset cursor (base64url) — see app-listing.service encode/decode.
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListAppListingsInput = z.infer<typeof listAppListingsSchema>;

/**
 * W13 POST-APPROVAL MOD MANAGEMENT — the moderator all-status listings read.
 *
 * Backs `appListings.listAllListingsForModeration` (moderatorProcedure): unlike
 * the public `listAvailable` (approved-only, public allowlist), this returns
 * listings across EVERY lifecycle status for the mod management table. All filters
 * are optional (omitted = the whole store); `search` matches name OR slug
 * server-side (case-insensitive). Keyset-paginated by the ULID `id` (a stable
 * total order), bounded `limit` ≤ 50 (mirrors `listListingReportsSchema`).
 */
export const listAllListingsForModerationSchema = z.object({
  // Full AppListing lifecycle set (draft|pending|approved|rejected|removed).
  status: z.enum(APP_LISTING_STATUSES).optional(),
  kind: z.enum(['onsite', 'offsite']).optional(),
  // Server-side name/slug substring filter (bounded; trimmed in the service).
  search: z.string().max(200).optional(),
  // Opaque keyset cursor = the last row's `id` (bounded, same as the sibling
  // mod-read queues). A tampered value just yields a different/empty page.
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export type ListAllListingsForModerationInput = z.infer<
  typeof listAllListingsForModerationSchema
>;

/** Detail lookup by EXACTLY ONE of slug or id (approved listings only). */
export const getAppListingDetailSchema = z
  .object({
    slug: z.string().min(1).max(64).optional(),
    id: z.string().min(1).max(64).optional(),
  })
  .refine((d) => (d.slug ? 1 : 0) + (d.id ? 1 : 0) === 1, {
    message: 'Provide exactly one of `slug` or `id`',
  });
export type GetAppListingDetailInput = z.infer<typeof getAppListingDetailSchema>;

// ---------------------------------------------------------------------------
// Public DTOs (allowlist projections).
// ---------------------------------------------------------------------------

export type ListingKind = 'onsite' | 'offsite';

/** Off-site apps come in two shapes (locked decision §6.4). */
export type OffsiteSubKind = 'connect' | 'external-link';

/**
 * Public creator chip — id/username/image ONLY (the standard public-user
 * projection subset). No email/PII. `null` only if the owner row vanished.
 */
export type ListingCreatorChip = {
  id: number;
  username: string | null;
  image: string | null;
};

/**
 * Recommend rollup, read from the `AppListingMetric` rollup (P5-populated).
 * `recommendPct` is `null` when there are no reviews yet (metric row absent OR
 * zero counts) so the UI can render "no reviews yet" instead of "0%".
 */
export type ListingRecommendRollup = {
  recommendedCount: number;
  notRecommendedCount: number;
  /** up / (up+down) in [0,1], or null when there are no reviews yet. */
  recommendPct: number | null;
};

/** Kind-specific card fields (discriminated by the card's `kind`). */
export type ListingCardKindData =
  | {
      kind: 'onsite';
      /** Backing AppBlock id (the runtime), or null for a native off-site row. */
      appBlockId: string | null;
      /** True when the app declares a launch page (Open CTA) vs a model-slot install (Install CTA). */
      hasPage: boolean;
    }
  | {
      kind: 'offsite';
      subKind: OffsiteSubKind;
      /** External-link target (Visit CTA). Null for a connect-only listing. */
      externalUrl: string | null;
    };

/** One store card over EITHER kind (the unified `/apps` grid). */
export type ListingCard = {
  id: string;
  slug: string;
  kind: ListingKind;
  name: string;
  tagline: string | null;
  category: string | null;
  contentRating: string | null;
  iconUrl: string | null;
  /** Cover image, or the first screenshot as a fallback, or null. */
  coverUrl: string | null;
  creator: ListingCreatorChip | null;
  recommend: ListingRecommendRollup;
  /** Total reviews reflected in the recommend rollup (recommended + not). */
  reviewCount: number;
  kindData: ListingCardKindData;
};

export type ListingGalleryScreenshot = {
  url: string;
  caption: string | null;
};

/** Kind-specific action data on the detail page. */
export type ListingDetailKindData =
  | {
      kind: 'onsite';
      appBlockId: string | null;
      hasPage: boolean;
      /** Already-public standalone block origin (no token/scope). */
      liveUrl: string;
    }
  | {
      kind: 'offsite';
      subKind: OffsiteSubKind;
      externalUrl: string | null;
      /** Public OAuth client_id for a connect-kind listing (NOT a secret); null otherwise. */
      connectClientId: string | null;
    };

/** Full public detail for one approved listing (card fields + gallery + body). */
export type ListingDetail = {
  id: string;
  /**
   * Integer surrogate key (`app_listings.serial_id`). Carried so the detail page
   * can mount the CommentsV2 discussion (`<CommentsProvider entityType="appListing"
   * entityId={serialId} />`) — CommentsV2 is integer-keyed, the store `id` is a TEXT
   * ULID. Public + non-sensitive (an opaque row number, like the numeric ids already
   * exposed for images/models/posts).
   */
  serialId: number;
  slug: string;
  kind: ListingKind;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  contentRating: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
  creator: ListingCreatorChip | null;
  recommend: ListingRecommendRollup;
  reviewCount: number;
  /** Ordered gallery — screenshots whose backing Image still exists (null-image rows dropped). */
  screenshots: ListingGalleryScreenshot[];
  kindData: ListingDetailKindData;
};
