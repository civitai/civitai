import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export const versionShowcaseSites = ['com', 'red'] as const;
export type VersionShowcaseSite = (typeof versionShowcaseSites)[number];

/** Community images a creator can feature per version per site. */
export const VERSION_SHOWCASE_LIMIT = 20;

/** civitai.com serves the green domain; every other domain gets the .red showcase. */
export const showcaseSiteForDomain = (domain: string | undefined): VersionShowcaseSite =>
  domain === 'green' ? 'com' : 'red';

/** A caller served only safe levels gets the .com showcase, as civitai.com does. */
export const showcaseSiteForBrowsingLevel = (browsingLevel: number): VersionShowcaseSite =>
  (browsingLevel & ~sfwBrowsingLevelsFlag) === 0 ? 'com' : 'red';

/** Which site's cover a cover id is: the .com one when it is the .com column's. */
export const siteForCoverId = (
  model: { sfwCoverImageId?: number | null },
  coverId: number | null
): VersionShowcaseSite => (coverId != null && coverId === model.sfwCoverImageId ? 'com' : 'red');

/** The model column that is slot 1 (the cover) of a site's showcase. */
export const coverColumnForSite = (site: VersionShowcaseSite) =>
  site === 'com' ? ('sfwCoverImageId' as const) : ('coverImageId' as const);

/** Whether a settings write turns the user's version showcase opt-out on or off. */
export const showcaseOptOutChanged = (
  before: { hideFromVersionShowcases?: boolean },
  input: { hideFromVersionShowcases?: boolean }
) =>
  'hideFromVersionShowcases' in input &&
  !!before.hideFromVersionShowcases !== !!input.hideFromVersionShowcases;

/**
 * Which list the model-page carousel (`prioritizedUserIds`) serves: a version's curated showcase
 * (an empty one serves nothing, never an unfiltered page), else the version image cache when its
 * flag is on, else the live owner-first query.
 */
export function carouselSource({
  prioritizeUser,
  versionCacheFlag,
  showcaseIds,
}: {
  prioritizeUser: boolean;
  versionCacheFlag: boolean;
  showcaseIds: number[] | null | undefined;
}): 'none' | 'curated' | 'empty' | 'version-cache' | 'live' {
  if (!prioritizeUser) return 'none';
  if (showcaseIds) return showcaseIds.length ? 'curated' : 'empty';
  return versionCacheFlag ? 'version-cache' : 'live';
}
