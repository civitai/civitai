import {
  effectiveBrowsingCeiling,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// Its own pure module: the gated-image read and the App Blocks output ceiling both
// read it, and neither needs the other's graph. (Not in `block-gated-images.logic`,
// whose importers are ledgered as gated-image CONSUMERS by its seam test.)

/**
 * A viewer's browsing-level ceiling from the block token: the domain ceiling
 * (`maxBrowsingLevel`) intersected with the viewer's own level
 * (`viewerBrowsingLevel`), clamped to selectable levels. Fails closed to PG when
 * either claim is absent, zero or non-selectable, so a malformed or legacy token
 * can only ever hide more. It is ALSO the App Blocks output ceiling
 * (`blockOutputCeilingFromClaims`), so a workflow output and a gated image are judged
 * at the same level.
 */
export function resolveViewerBrowsingLevel(claims: {
  maxBrowsingLevel?: number | null;
  viewerBrowsingLevel?: number | null;
}): number {
  if (typeof claims.maxBrowsingLevel !== 'number') return publicBrowsingLevelsFlag;
  const selectable = onlySelectableLevels(
    effectiveBrowsingCeiling(claims.maxBrowsingLevel, claims.viewerBrowsingLevel)
  );
  return selectable || publicBrowsingLevelsFlag;
}
