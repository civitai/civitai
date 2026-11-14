export const versionShowcaseSites = ['com', 'red'] as const;
export type VersionShowcaseSite = (typeof versionShowcaseSites)[number];

/** Community images per version per site; the carousel shows at most this many images. */
export const VERSION_SHOWCASE_LIMIT = 20;

/** civitai.com serves the green domain; every other domain gets the .red showcase. */
export const showcaseSiteForDomain = (domain: string | undefined): VersionShowcaseSite =>
  domain === 'green' ? 'com' : 'red';

/** The model column that is slot 1 (the cover) of a site's showcase. */
export const coverColumnForSite = (site: VersionShowcaseSite) =>
  site === 'com' ? ('sfwCoverImageId' as const) : ('coverImageId' as const);
