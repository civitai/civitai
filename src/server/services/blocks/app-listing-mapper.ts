import { Prisma } from '@prisma/client';

import { validateRepositoryUrl } from '~/server/schema/blocks/external-app.schema';
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
 * Extract the optional one-line store tagline from the manifest (null when
 * absent / blank / not a string). The manifest is the ONLY author surface for an
 * onsite listing's tagline — see the "ONSITE = ASSETS-ONLY" invariant in
 * `offsite-listing.service`, which keeps name/tagline/description/category
 * manifest-governed. The submission validator already bounds the length
 * (MANIFEST_TAGLINE_MAX_LENGTH); this resolver only normalises whitespace, so a
 * legacy row that predates the validator can never crash the mapper.
 */
export function resolveListingTagline(manifest: unknown): string | null {
  const m = (manifest ?? {}) as { tagline?: unknown };
  const tagline = typeof m.tagline === 'string' ? m.tagline.trim() : '';
  return tagline.length > 0 ? tagline : null;
}

/**
 * Extract the optional PUBLIC SOURCE-REPOSITORY link from the manifest's `repository`
 * key (null when absent / blank / not a string).
 *
 * 🔴 IT RETURNS THE NORMALISED FORM, not the raw manifest string, because equality on
 * this value is load-bearing downstream: the off-site material-change check compares a
 * proposed link against the stored one, and `https://github.com/a/b/` vs
 * `https://github.com/a/b.git` are the SAME repository. Normalising at every write —
 * manifest resolve included — is what makes those comparisons stable.
 *
 * 🔴 A STORED VALUE THAT NO LONGER VALIDATES RESOLVES TO NULL, deliberately. The
 * submission validator already gates this key, so an invalid value can only reach here
 * from a row that predates the validator or from a later tightening of the host
 * allowlist — and in BOTH cases the honest answer on a public store page is to show no
 * Source row, not to render a link the current rules would reject. Mirrors
 * `resolveListingTagline`'s "a legacy row can never crash the mapper" posture, one step
 * stronger: it can never SERVE a now-disallowed link either.
 */
export function resolveListingSourceRepo(manifest: unknown): string | null {
  const m = (manifest ?? {}) as { repository?: unknown };
  if (typeof m.repository !== 'string') return null;
  const validated = validateRepositoryUrl(m.repository);
  return validated.ok ? validated.url : null;
}

/**
 * The MANIFEST-GOVERNED scalar set of an onsite store listing, in the shape the
 * approve path writes on a subsequent-version re-sync.
 *
 * SINGLE SOURCE with {@link mapAppBlockToListing} (which builds its own payload
 * from the same resolvers), so the create path and the re-sync path can never
 * drift into showing different copy for the same manifest.
 *
 * NOT included — these are curated/mod-owned and must never be clobbered by an
 * approve: assets (icon/cover/screenshots), `featured`/`featuredOrder`,
 * `contentRating` (mod override, floored at the derived rating), `status`,
 * `slug`, `externalUrl`.
 *
 * `category` is passed in RATHER than read from the manifest on purpose: the
 * approve path resolves it from `AppBlock.category`, which is the manifest value
 * only when a moderator has NOT curated one (`setMarketplaceMeta` writes
 * `AppBlock.category`). Reading the manifest directly here would silently undo
 * mod curation on the next version bump.
 */
export type ListingScalarSync = {
  name: string;
  description: string | null;
  tagline: string | null;
  category: string | null;
  /**
   * The public source-repository link. 🔴 The key is ABSENT ENTIRELY — not `null` —
   * when the manual-apply `source_repo_url` column is unavailable, so the resulting
   * Prisma `data` cannot name a column the database does not have. See
   * `sourceRepoAvailable` on the builder.
   */
  sourceRepoUrl?: string | null;
};

export function buildListingScalarSync(args: {
  manifest: unknown;
  blockId: string;
  category: string | null;
  /**
   * Whether `app_listings.source_repo_url` exists (probe it with
   * `isSourceRepoColumnAvailable`).
   *
   * 🔴 DEFAULTS TO FALSE — fail-safe, and the direction matters. Omitting the key
   * makes the feature inert; including it against a missing column makes the whole
   * write throw, and BOTH call sites of this builder are pre-existing log-and-continue
   * paths, so that throw would not surface as an error — it would silently stop store
   * listings being minted for newly approved apps. A caller that forgets the flag
   * therefore loses the new field, never the old behaviour.
   */
  sourceRepoAvailable?: boolean;
}): ListingScalarSync {
  return {
    name: resolveListingName(args.manifest, args.blockId),
    description: resolveListingDescription(args.manifest),
    tagline: resolveListingTagline(args.manifest),
    category: args.category,
    // 🔴 RESOLVED FROM THE MANIFEST ON EVERY SYNC, exactly like `tagline`, and that is
    // the whole point of it living here rather than only in `mapAppBlockToListing`. A
    // value set at the FIRST approve and never re-read would leave an author who added
    // (or removed) `repository` in v1.1.0 staring at the v1.0.0 link forever — the
    // identical bug #3441 fixed for name/description/tagline. Removing the manifest key
    // resolves to `null`, which CLEARS the column: manifest-governed means the manifest
    // is the whole truth, not a one-way seed.
    ...(args.sourceRepoAvailable ? { sourceRepoUrl: resolveListingSourceRepo(args.manifest) } : {}),
  };
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
export function mapAppBlockToListing(
  ab: SourceAppBlock,
  opts: {
    /**
     * Whether `app_listings.source_repo_url` exists — same fail-safe-false contract as
     * {@link buildListingScalarSync}'s flag. Absent ⇒ the key is omitted from the
     * create payload, so this mapper keeps producing a payload the pre-migration
     * database accepts.
     */
    sourceRepoAvailable?: boolean;
  } = {}
): Prisma.AppListingUncheckedCreateInput {
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
    // Manifest-governed one-liner for the store card/detail slot. Absent/blank in
    // the manifest ⇒ NULL (the card renders no tagline) — same as description.
    tagline: resolveListingTagline(ab.manifest),
    // Manifest-governed public source-repo link, on the SAME terms as `tagline`.
    // Key omitted (not null) when the manual-apply column is absent — see the opts flag.
    ...(opts.sourceRepoAvailable ? { sourceRepoUrl: resolveListingSourceRepo(ab.manifest) } : {}),
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
