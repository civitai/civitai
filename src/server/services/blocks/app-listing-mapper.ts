import { Prisma } from '@prisma/client';

import { newAppListingId } from '~/server/utils/app-block-ids';

/**
 * App Store Listings (W13) — shared AppBlock→AppListing mapping.
 *
 * SINGLE SOURCE OF TRUTH for the store-listing SHAPE derived from an approved
 * `AppBlock`. Two call sites depend on it and MUST NOT drift:
 *   - `app-listing-backfill.service` — the mod-only stopgap that mints a listing
 *     per already-approved AppBlock (batch, per-row isolated).
 *   - `publish-request.service.approveRequest` — the go-forward path that mints
 *     the onsite listing at moderator-approve time (so an approved app appears on
 *     the `/apps` grid without a manual backfill run).
 *
 * Pure + IO-free (only depends on the crypto-backed `newAppListingId`), so it is
 * unit-testable without booting the env-coupled Prisma client and safe to import
 * from either service.
 */

/**
 * The minimal AppBlock projection the mapper needs. Mirrors the columns the
 * backfill selects; the approve path constructs it from the freshly-approved
 * AppBlock's in-scope values.
 */
export type SourceAppBlock = {
  id: string;
  blockId: string;
  manifest: unknown;
  contentRating: string;
  category: string | null;
  featured: boolean;
  featuredOrder: number | null;
  externalUrl: string | null;
  app: { userId: number } | null;
};

/**
 * Extract a display name from the block manifest, mirroring the marketplace's
 * own fallback (user-app-surface.service): manifest.name if a non-empty string,
 * else the slug (blockId).
 */
export function resolveListingName(manifest: unknown, blockId: string): string {
  const m = (manifest ?? {}) as { name?: unknown };
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  return name.length > 0 ? name : blockId;
}

/** Extract an optional description from the manifest (null when absent/blank). */
export function resolveListingDescription(manifest: unknown): string | null {
  const m = (manifest ?? {}) as { description?: unknown };
  const desc = typeof m.description === 'string' ? m.description.trim() : '';
  return desc.length > 0 ? desc : null;
}

/**
 * Pure mapping from an approved AppBlock to the AppListing create payload.
 * Requires a resolved owner (`app.userId`) — the callers guard the null-owner
 * case; a missing owner here is misuse, so throw loudly rather than silently
 * minting an invalid `userId` that would fail the FK.
 *
 * `status` is ALWAYS 'approved' (the store's read filter) — an approved AppBlock
 * yields an approved listing. `kind` is derived from `externalUrl` presence:
 * on-site (hosted, external_url IS NULL) → 'onsite'; the #2821 external-link rows
 * → 'offsite'. The approve path only ever passes hosted (externalUrl=null) blocks
 * → 'onsite'; the offsite external-submission flow owns its own listing writes.
 */
export function mapAppBlockToListing(ab: SourceAppBlock): Prisma.AppListingUncheckedCreateInput {
  if (!ab.app || typeof ab.app.userId !== 'number') {
    throw new Error(`mapAppBlockToListing: AppBlock ${ab.id} has no resolvable owner`);
  }
  const isOffsite = typeof ab.externalUrl === 'string' && ab.externalUrl.length > 0;
  return {
    id: newAppListingId(),
    kind: isOffsite ? 'offsite' : 'onsite',
    slug: ab.blockId,
    name: resolveListingName(ab.manifest, ab.blockId),
    description: resolveListingDescription(ab.manifest),
    // Assets are P1 — left NULL here (no mandatory-asset enforcement in P0).
    iconId: null,
    coverId: null,
    category: ab.category,
    status: 'approved',
    // Single source of truth: mirror the runtime AppBlock rating.
    contentRating: ab.contentRating,
    // Off-site external-link target; NULL for on-site. No OAuth-connect in the
    // backfill (#2821 rows are pure external-link).
    externalUrl: isOffsite ? ab.externalUrl : null,
    connectClientId: null,
    appBlockId: ab.id,
    featured: ab.featured,
    featuredOrder: ab.featuredOrder,
    userId: ab.app.userId,
  };
}
