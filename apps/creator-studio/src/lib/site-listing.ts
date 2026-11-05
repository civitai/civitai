import { allBrowsingLevelsFlag, Flags, sfwBrowsingLevelsFlag } from '@civitai/shared';

export type Site = 'com' | 'red';
/** The models page's site filter: on both sites, or on only one of them. */
export type SiteFilter = 'both' | Site;

export function parseSiteFilter(value: string | null | undefined): SiteFilter | undefined {
  return value === 'both' || value === 'com' || value === 'red' ? value : undefined;
}

export type SiteListing = { com: boolean; red: boolean; note: string | null };

/**
 * Which public site's feeds list a model, read off the columns the main app keeps current:
 * civitai.com keeps a model whose `nsfwLevel` has a PG or PG-13 bit, civitai.red one with any rating
 * bit. The people and child rules copy the main app's default browsing add-ons, so they can lag a
 * live change to those. `siteFilterSql` in `$lib/server/models` is the SQL twin of this and must
 * stay in step.
 */
export function siteListing(model: {
  status: string;
  availability: string;
  mode: string | null;
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
  hasPeopleTag: boolean;
  hasChildTag: boolean;
}): SiteListing {
  const off = (note: string) => ({ com: false, red: false, note });
  if (model.status !== 'Published') return off('Not published');
  if (model.availability === 'Private') return off('Private: only you can see it');
  if (model.mode === 'Archived') return off('Archived');
  if (model.poi || model.hasPeopleTag) return off('Models of real people are hidden on both sites');
  if (!Flags.intersects(model.nsfwLevel, allBrowsingLevelsFlag))
    return off(model.nsfwLevel === 0 ? 'Not rated yet' : 'Blocked');
  const hiddenOnRed = model.minor || model.hasChildTag;
  return {
    com: Flags.intersects(model.nsfwLevel, sfwBrowsingLevelsFlag),
    red: !hiddenOnRed,
    note: hiddenOnRed ? 'Hidden from mature browsing on civitai.red' : null,
  };
}
