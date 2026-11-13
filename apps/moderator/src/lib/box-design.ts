import type { RewardInfo } from '$lib/mystery-box';

/**
 * Strips the " - <team>" suffix an event's per-team cosmetics carry, so they read as one design.
 * `designSql` in item-definitions.service.ts is the SQL twin; item-catalog.pglite.test.ts pins both to
 * the same answers.
 */
export const designName = (name: string, team: string | null | undefined): string => {
  if (typeof team !== 'string') return name;
  const suffix = ` - ${team}`;
  return name.length > suffix.length && name.endsWith(suffix)
    ? name.slice(0, -suffix.length)
    : name;
};

/** The catalog's own key for a design; a reward carries the same one so the tray and the catalog agree on which design is which. */
export const designKeyOf = (event: string | null, type: string, design: string) =>
  `${event ?? ''}|${type}|${design}`;

export type FlowReward = RewardInfo & { shelf: number | null; design: string; designKey: string };

export type CatalogVariant = {
  cosmeticId: number;
  /** null until the cosmetic has an item definition. */
  definitionId: number | null;
  name: string;
  team: string | null;
  url: string | null;
  shelf: number | null;
};

export type CatalogDesign = {
  key: string;
  name: string;
  type: string;
  event: string | null;
  /** The lowest shelf price among its variants. */
  shelf: number | null;
  variants: CatalogVariant[];
};

export type CatalogResult = { designs: CatalogDesign[]; total: number };

export type CosmeticEvent = { event: string; teams: string[] };

export const isDefined = (design: CatalogDesign) =>
  design.variants.every((variant) => variant.definitionId !== null);

export function rewardOfVariant(design: CatalogDesign, variant: CatalogVariant): FlowReward | null {
  if (variant.definitionId === null) return null;
  return {
    id: variant.definitionId,
    type: 'cosmetic',
    name: variant.name,
    cosmeticId: variant.cosmeticId,
    team: variant.team,
    imageUrl: variant.url,
    shelf: variant.shelf,
    design: design.name,
    designKey: design.key,
  };
}

export const CATALOG_PAGE = 48;
export const CATALOG_MAX = 480;

/** `CatalogFilters.event`: '' is any event, NO_EVENT is cosmetics of no event. */
export const NO_EVENT = '__none';
export type ShelfBand = '' | 'uncommon' | 'rare' | 'legendary' | 'none';
export type CatalogFilters = {
  q: string;
  event: string;
  types: string[];
  team: string;
  band: ShelfBand;
  needsDefinition: boolean;
  limit: number;
};
export const EMPTY_FILTERS: CatalogFilters = {
  q: '',
  event: '',
  types: [],
  team: '',
  band: '',
  needsDefinition: false,
  limit: CATALOG_PAGE,
};

/** `bands` must be the tier preset's, so a band filter matches what the preset would place there. */
export function catalogParams(
  filters: CatalogFilters,
  bands: { uncommon: number; rare: number }
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.event === NO_EVENT) params.set('noEvent', '1');
  else if (filters.event) params.set('event', filters.event);
  if (filters.types.length) params.set('types', filters.types.join(','));
  if (filters.team) params.set('team', filters.team);
  if (filters.band === 'none') params.set('noShelf', '1');
  if (filters.band === 'uncommon') params.set('maxShelf', String(bands.uncommon));
  if (filters.band === 'rare') {
    params.set('minShelf', String(bands.uncommon + 1));
    params.set('maxShelf', String(bands.rare));
  }
  if (filters.band === 'legendary') params.set('minShelf', String(bands.rare + 1));
  if (filters.needsDefinition) params.set('needsDefinition', '1');
  params.set('limit', String(filters.limit));
  return params;
}
