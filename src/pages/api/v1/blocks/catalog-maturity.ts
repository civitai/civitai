import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import {
  allBrowsingLevelsFlag,
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
 * IMPORTANT (advisory until #2670 merges): the `maxBrowsingLevel` claim is
 * MINTED by PR #2670. Until that lands, no token carries it → every token
 * resolves to the SFW ceiling here (the safe GA posture). The red-domain
 * unclamp path activates automatically once #2670 stamps the claim. When
 * #2670 merges, this can delegate to the shared `domainBrowsingCeiling` /
 * `resolveBlockMaturity` it introduces in browsingLevel.constants.ts /
 * blocks.router.ts (single source of truth) — see the follow-up note in the PR.
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

  // SFW iff the ceiling is a subset of the SFW flag (red carries nsfw bits →
  // not SFW). Drives the per-image filter: no nsfw cover image on a SFW ceiling.
  const isSfwCeiling = Flags.intersection(ceiling, sfwBrowsingLevelsFlag) === ceiling;

  return { browsingLevel, isSfwCeiling };
}
