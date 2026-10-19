import type { RewardInfo } from '$lib/mystery-box';

/**
 * An event ships one cosmetic per team, each named "<design> - <team>". Strips that suffix so the four
 * rows read as one design. `cosmeticDesignSql` in the item-definitions service is this rule in SQL;
 * a test pins them to the same answers.
 */
export const designName = (name: string, team: string | null | undefined): string => {
  if (typeof team !== 'string') return name;
  const suffix = ` - ${team}`;
  return name.length > suffix.length && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

/** A reward as the builder flow shows it: the shelf price steers tier placement, the design name groups team variants. */
export type FlowReward = RewardInfo & { shelf: number | null; design: string };

/** One cosmetic of a catalog design. `definitionId` is null until the cosmetic has an item definition. */
export type CatalogVariant = {
  cosmeticId: number;
  definitionId: number | null;
  name: string;
  team: string | null;
  url: string | null;
};

/** A design in the catalog: every team variant of one cosmetic design, or one team-less cosmetic. */
export type CatalogDesign = {
  key: string;
  name: string;
  type: string;
  event: string | null;
  shelf: number | null;
  variants: CatalogVariant[];
};

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
    shelf: design.shelf,
    design: design.name,
  };
}

/** What the catalog panel asks for. `event` is '' for any, NO_EVENT for cosmetics of no event. */
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
export const CATALOG_PAGE = 48;
export const EMPTY_FILTERS: CatalogFilters = {
  q: '',
  event: '',
  types: [],
  team: '',
  band: '',
  needsDefinition: false,
  limit: CATALOG_PAGE,
};

/** The query string for `/catalog`; `bands` are the price lines the tier preset uses, so a band filter and a preset agree. */
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
