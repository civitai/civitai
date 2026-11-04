import { allBrowsingLevelsFlag, Flags, sfwBrowsingLevelsFlag } from '@civitai/shared';

export type Site = 'com' | 'red';
/** The models page's site filter: on both sites, or on only one of them. */
export type SiteFilter = 'both' | Site;

export function parseSiteFilter(value: string | null | undefined): SiteFilter | undefined {
  return value === 'both' || value === 'com' || value === 'red' ? value : undefined;
}

export type SiteListing = { com: boolean; red: boolean; note: string | null };

/**
 * Which public site lists a model, read off the columns the main app keeps current: civitai.com's
 * feed keeps a model whose `nsfwLevel` has a PG or PG-13 bit, civitai.red's one with any rating bit.
 * Minor and POI rules copy the main app's default browsing add-ons, so they can lag a live change
 * to those. `siteFilterSql` in `$lib/server/models` is the SQL twin of this and must stay in step.
 */
export function siteListing(model: {
  status: string;
  availability: string;
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
}): SiteListing {
  const off = (note: string) => ({ com: false, red: false, note });
  if (model.status !== 'Published') return off('Not published');
  if (model.availability === 'Private') return off('Private: only you can see it');
  if (model.poi) return off('Models of real people are hidden on both sites');
  if (!Flags.intersects(model.nsfwLevel, allBrowsingLevelsFlag))
    return off(model.nsfwLevel === 0 ? 'Not rated yet' : 'Blocked');
  return {
    com: Flags.intersects(model.nsfwLevel, sfwBrowsingLevelsFlag),
    red: !model.minor,
    note: model.minor ? 'Hidden from mature browsing on civitai.red' : null,
  };
}
