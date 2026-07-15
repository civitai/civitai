import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import {
  allBrowsingLevelsFlag,
  allowMatureContentForCeiling,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

/**
 * Authoritative App-Blocks catalog maturity clamp (Phase 3; GA-safety
 * follow-up to PR #2670). Catalog-generic: the SINGLE shared clamp for BOTH
 * block catalog endpoints (/api/v1/blocks/models AND /api/v1/blocks/images) —
 * there is no per-type duplicate. Kept in a server-import-free module so the
 * security-critical clamp can be unit-tested without dragging the Prisma
 * client (both endpoints statically import a search service → eager Prisma
 * load).
 *
 * The EFFECTIVE browsing level is the bitwise intersection (AND) of the
 * broadest possible request and the token's domain ceiling
 * (`claims.maxBrowsingLevel`):
 *
 *   - Ceiling = the token's `maxBrowsingLevel` claim. FAIL CLOSED: an absent /
 *     non-finite claim resolves to the SFW ceiling (the most restrictive
 *     non-empty flag). The middleware already rejects a present-but-non-finite
 *     claim at verify time; this handles "absent" (legacy / pre-#2670 token).
 *   - The client CANNOT widen past the ceiling: intersection(req, ceiling) ⊆
 *     ceiling for ANY req. We intersect the BROADEST request
 *     (allBrowsingLevelsFlag) with the ceiling, which collapses to exactly the
 *     ceiling — so no client-supplied maturity field is ever read or honored.
 *
 * The `maxBrowsingLevel` claim is MINTED by PR #2670 (now merged). The SFW /
 * mature determination here DELEGATES to that PR's single source of truth,
 * `allowMatureContentForCeiling` in browsingLevel.constants.ts (the same helper
 * the generation belt in blocks.router.ts uses), so the catalog and generation
 * paths can never drift on what "this domain's ceiling allows mature content"
 * means. The intersection clamp below is the catalog-specific application of
 * that ceiling to a browsing-level filter.
 */
export function resolveCatalogBrowsingLevel(
  claims: Pick<BlockTokenClaims, 'maxBrowsingLevel'>,
  opts: {
    /**
     * When true, the viewer's geo is currently restricted (see
     * `isRegionRestricted` — e.g. GB/AU). The effective level is then clamped
     * DOWN to SFW, on TOP of the token-ceiling clamp. This mirrors the region
     * override the public /api/v1/{models,images} endpoints apply
     * (`if (isRegionRestricted) browsingLevel = sfwBrowsingLevelsFlag`) — the
     * block endpoints reuse the same search services but previously skipped it,
     * so a red-domain block viewed from a restricted region could still surface
     * mature catalog content. GA-safety gap close.
     */
    regionRestricted?: boolean;
  } = {}
): {
  browsingLevel: number;
  isSfwCeiling: boolean;
} {
  const ceiling =
    typeof claims.maxBrowsingLevel === 'number' && Number.isFinite(claims.maxBrowsingLevel)
      ? claims.maxBrowsingLevel
      : sfwBrowsingLevelsFlag; // fail closed

  // The clamp: intersect the broadest possible request with the ceiling. A
  // client can never widen because (anything ∩ ceiling) ⊆ ceiling.
  let browsingLevel = Flags.intersection(allBrowsingLevelsFlag, ceiling);

  // SFW iff the ceiling permits NO mature content. Delegate to #2670's single
  // source of truth (`allowMatureContentForCeiling` returns `false` for a
  // ceiling carrying no nsfw bits, `undefined` only when mature is allowed —
  // i.e. red) instead of re-deriving the SFW-ceiling test here. Behaviorally
  // identical to `intersection(ceiling, sfwFlag) === ceiling` because the SFW
  // and nsfw flags are disjoint and partition allBrowsingLevels. Drives the
  // per-image filter: no nsfw cover image on a SFW ceiling.
  let isSfwCeiling = allowMatureContentForCeiling(ceiling) === false;

  // Region restriction clamp — applied AFTER the ceiling clamp, and ONLY ever
  // narrows. We INTERSECT with SFW (not override like the public endpoints) so
  // a sub-SFW ceiling (e.g. a green block that only allows PG) is never WIDENED
  // back up to the full SFW set: region restriction can only remove bits, never
  // add them. The result is the more-restrictive of (ceiling clamp, SFW).
  if (opts.regionRestricted) {
    browsingLevel = Flags.intersection(browsingLevel, sfwBrowsingLevelsFlag);
    isSfwCeiling = true;
  }

  return { browsingLevel, isSfwCeiling };
}

/**
 * Whether a generation resource EXCEEDS the clamped catalog `browsingLevel` — used
 * by the block `generation-resources` rehydrate endpoint to drop mature resources
 * from a SFW-domain block's response (so a saved-generator rehydrate can't surface
 * a mature resource's public trained words / recommended settings to a SFW block).
 *
 * The resource's maturity signal is the max of its cover-image `nsfwLevel` and the
 * model's boolean `nsfw` flag (a mature model with no/SFW cover still counts). A 0
 * signal (no maturity data) is treated as WITHIN the ceiling — the projection
 * carries no image, and a bare resource with no maturity signal is not "mature".
 * PURE + server-import-free (like the rest of this module) so it is unit-testable.
 */
export function resourceExceedsCatalogCeiling(
  resource: { imageNsfwLevel?: number | null; modelNsfw?: boolean | null },
  browsingLevel: number
): boolean {
  const imageLevel = resource.imageNsfwLevel ?? 0;
  // A mature-flagged model with no usable image level still gets a mature floor
  // (R — the lowest nsfw browsing-level bit).
  const level = imageLevel !== 0 ? imageLevel : resource.modelNsfw ? NsfwLevel.R : 0;
  if (level === 0) return false; // no maturity signal → within ceiling
  // Exceeds when the resource's maturity bit is NOT permitted by the ceiling.
  return !Flags.intersects(browsingLevel, level);
}
