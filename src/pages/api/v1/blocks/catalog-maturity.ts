import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import {
  allBrowsingLevelsFlag,
  allowMatureContentForCeiling,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
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
export function resolveCatalogBrowsingLevel(claims: Pick<BlockTokenClaims, 'maxBrowsingLevel'>): {
  browsingLevel: number;
  isSfwCeiling: boolean;
} {
  const ceiling =
    typeof claims.maxBrowsingLevel === 'number' && Number.isFinite(claims.maxBrowsingLevel)
      ? claims.maxBrowsingLevel
      : sfwBrowsingLevelsFlag; // fail closed

  // The clamp: intersect the broadest possible request with the ceiling. A
  // client can never widen because (anything ∩ ceiling) ⊆ ceiling.
  const browsingLevel = Flags.intersection(allBrowsingLevelsFlag, ceiling);

  // SFW iff the ceiling permits NO mature content. Delegate to #2670's single
  // source of truth (`allowMatureContentForCeiling` returns `false` for a
  // ceiling carrying no nsfw bits, `undefined` only when mature is allowed —
  // i.e. red) instead of re-deriving the SFW-ceiling test here. Behaviorally
  // identical to `intersection(ceiling, sfwFlag) === ceiling` because the SFW
  // and nsfw flags are disjoint and partition allBrowsingLevels. Drives the
  // per-image filter: no nsfw cover image on a SFW ceiling.
  const isSfwCeiling = allowMatureContentForCeiling(ceiling) === false;

  return { browsingLevel, isSfwCeiling };
}
