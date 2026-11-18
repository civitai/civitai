import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import {
  allowMatureContentForCeiling,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * The browsing level an App Blocks catalog route serves a VIEWER at: the
 * viewer's own level held to the domain cap, by the main site's rule
 * (`clampToDomainCap`, `src/server/utils/browsing-level.ts`): `(requested & cap) || cap`.
 *
 *   - cap = the token's domain ceiling (`resolveCatalogBrowsingLevel`: the
 *     `maxBrowsingLevel` claim, SFW when absent), narrowed to SFW for a
 *     region-restricted viewer.
 *   - requested = the token's `viewerBrowsingLevel` claim (already the viewer's
 *     level ∩ the domain at mint). Absent or malformed → PG, the fail-closed
 *     floor `resolveViewerBrowsingLevel` uses for a legacy token.
 *
 * So the result is NEVER wider than the domain cap, and NEVER above the viewer's
 * own level when that level shares any level with the cap. When it shares none
 * (e.g. a viewer whose saved level is mature-only, on a SFW domain, minted as
 * `viewerBrowsingLevel: 0`), the result is the cap, as the main site serves that
 * viewer, rather than an empty page.
 *
 * Returns 0 only when the cap itself is empty. Callers must treat 0 as "serve
 * nothing": the image search reads 0 as its DEFAULT level, not as none.
 */
export function resolveCatalogViewerBrowsingLevel(
  claims: Pick<BlockTokenClaims, 'maxBrowsingLevel' | 'viewerBrowsingLevel'>,
  opts: { regionRestricted?: boolean } = {}
): number {
  const cap = onlySelectableLevels(resolveCatalogBrowsingLevel(claims, opts).browsingLevel);
  const viewer = claims.viewerBrowsingLevel;
  const requested =
    typeof viewer === 'number' && Number.isInteger(viewer) && viewer >= 0
      ? viewer
      : publicBrowsingLevelsFlag;
  return onlySelectableLevels(requested & cap) || cap;
}

/**
 * `resolveCatalogViewerBrowsingLevel`, plus whether that level is a SFW ceiling:
 * no mature level in it (`allowMatureContentForCeiling` is `false`). An empty
 * level (0) counts as SFW.
 */
export function resolveCatalogViewerMaturity(
  claims: Pick<BlockTokenClaims, 'maxBrowsingLevel' | 'viewerBrowsingLevel'>,
  opts: { regionRestricted?: boolean } = {}
): { browsingLevel: number; isSfwCeiling: boolean } {
  const browsingLevel = resolveCatalogViewerBrowsingLevel(claims, opts);
  return { browsingLevel, isSfwCeiling: allowMatureContentForCeiling(browsingLevel) === false };
}
