import { accessPrice, resolveModelVersionPricing, type ModelVersionTerms } from '@civitai/buzz';
import { sfwBrowsingLevelsFlag } from '@civitai/shared';
import { ecosystemByKey, getBaseModelGroup } from '@civitai/shared/basemodel.constants';

// A cell's figures are shown only when this many distinct sellers are in it. Aggregate prices over a thin
// bucket would otherwise read as one creator's price list.
export const MIN_SELLERS_PER_CELL = 5;

// Lower bounds of the Buzz price bands, in order.
export const PRICE_BANDS = [0, 100, 250, 500, 1000, 2500] as const;

export const OTHER_ECOSYSTEM = 'Other';

// Model types with a bucket of their own; every other type is 'Other'.
export const NAMED_TYPES = ['LORA', 'Checkpoint'] as const;

export type Rating = 'sfw' | 'nsfw';
export type Access = 'early' | 'permanent';
export type TypeBucket = (typeof NAMED_TYPES)[number] | 'Other';

export type GatedRow = {
  modelId: number;
  ownerId: number;
  type: string;
  baseModel: string | null;
  nsfwLevel: number;
  timeframeDays: number | null;
  endsAt: Date | null;
  terms: unknown;
};

export type MarketFilters = {
  rating?: Rating;
  access?: Access;
  type?: TypeBucket;
  ecosystem?: string;
};

type PaidEntry = {
  modelId: number;
  rating: Rating;
  type: TypeBucket;
  ecosystem: string;
  access: Access;
  band: number;
};

/** Server-side only: holds model ids. The browser gets `marketView` output. */
export type MarketSnapshot = {
  paid: PaidEntry[];
  /** Seller count of every cell kept, for `assertFloor`. Never sent. */
  cellSellers: Record<string, number>;
  ecosystems: string[];
  suppressed: number;
  builtAt: string;
};

export const ratingOf = (nsfwLevel: number): Rating =>
  (nsfwLevel & ~sfwBrowsingLevelsFlag) === 0 ? 'sfw' : 'nsfw';

export const typeBucketOf = (type: string): TypeBucket =>
  (NAMED_TYPES as readonly string[]).includes(type) ? (type as TypeBucket) : 'Other';

export function priceBand(price: number): number {
  let band = 0;
  PRICE_BANDS.forEach((min, i) => {
    if (price >= min) band = i;
  });
  return band;
}

const cellKey = (e: Omit<PaidEntry, 'modelId'>) =>
  `${e.rating}|${e.type}|${e.ecosystem}|${e.access}|${e.band}`;

// Paid as the site's "Hide paid" filter reads it: a free-generation gate with no download tier is free.
const isPaid = (r: GatedRow) =>
  !resolveModelVersionPricing({
    paidAccess: { endsAt: r.endsAt, terms: r.terms as ModelVersionTerms },
  }).free;

/**
 * Which ecosystems are shown by name: those with at least the floor of paid sellers over the whole catalogue.
 * Fixed once per snapshot, before any cell is built, so "Other" has the same members in every filtered view and
 * comparing two views cannot isolate one of them.
 */
export function namedEcosystems(rows: GatedRow[]): Set<string> {
  const sellers = new Map<string, Set<number>>();
  for (const r of rows.filter(isPaid)) {
    const eco = getBaseModelGroup(r.baseModel ?? '');
    sellers.set(eco, (sellers.get(eco) ?? new Set<number>()).add(r.ownerId));
  }
  return new Set(
    [...sellers]
      .filter(([eco, s]) => eco !== OTHER_ECOSYSTEM && s.size >= MIN_SELLERS_PER_CELL)
      .map(([eco]) => eco)
  );
}

/** Applies the floor, cell by cell, and keeps only what survives. */
export function buildMarketSnapshot(gated: GatedRow[], now = new Date()): MarketSnapshot {
  const named = namedEcosystems(gated);
  const cells = new Map<string, { sellers: Set<number>; entries: PaidEntry[] }>();
  for (const r of gated.filter(isPaid)) {
    const eco = getBaseModelGroup(r.baseModel ?? '');
    const entry: Omit<PaidEntry, 'modelId'> = {
      rating: ratingOf(r.nsfwLevel),
      type: typeBucketOf(r.type),
      ecosystem: named.has(eco) ? eco : OTHER_ECOSYSTEM,
      access: r.timeframeDays == null ? 'permanent' : 'early',
      band: priceBand(accessPrice(r.terms as ModelVersionTerms) ?? 0),
    };
    const k = cellKey(entry);
    const cell = cells.get(k) ?? { sellers: new Set<number>(), entries: [] };
    cell.sellers.add(r.ownerId);
    cell.entries.push({ ...entry, modelId: r.modelId });
    cells.set(k, cell);
  }

  const cellSellers: Record<string, number> = {};
  const paid: PaidEntry[] = [];
  let suppressed = 0;
  for (const [k, cell] of cells) {
    if (cell.sellers.size < MIN_SELLERS_PER_CELL) {
      suppressed++;
      continue;
    }
    cellSellers[k] = cell.sellers.size;
    paid.push(...cell.entries);
  }

  const ecosystems = [...new Set(paid.map((e) => e.ecosystem))].sort((a, b) =>
    a === OTHER_ECOSYSTEM ? 1 : b === OTHER_ECOSYSTEM ? -1 : a.localeCompare(b)
  );
  const snapshot: MarketSnapshot = {
    paid,
    cellSellers,
    ecosystems,
    suppressed,
    builtAt: now.toISOString(),
  };
  assertFloor(snapshot);
  return snapshot;
}

/** Backstop: throws when any figure the snapshot could show comes from a cell under the floor. */
export function assertFloor(s: MarketSnapshot) {
  if (s.paid.some((e) => (s.cellSellers[cellKey(e)] ?? 0) < MIN_SELLERS_PER_CELL))
    throw new Error('market overview: a cell under the seller floor reached the snapshot');
}

export type MarketView = {
  models: number;
  versions: number;
  early: number;
  permanent: number;
  histogram: { min: number; max: number | null; versions: number }[];
  ecosystems: { key: string; label: string }[];
  /** Hidden cells across the whole catalogue, not only this view. */
  suppressed: number;
  builtAt: string;
};

const ecosystemLabel = (key: string) =>
  key === OTHER_ECOSYSTEM ? 'Other ecosystems' : (ecosystemByKey.get(key)?.displayName ?? key);

export function marketView(s: MarketSnapshot, f: MarketFilters): MarketView {
  const paid = s.paid.filter(
    (e) =>
      (!f.rating || e.rating === f.rating) &&
      (!f.type || e.type === f.type) &&
      (!f.ecosystem || e.ecosystem === f.ecosystem) &&
      (!f.access || e.access === f.access)
  );
  return {
    models: new Set(paid.map((e) => e.modelId)).size,
    versions: paid.length,
    early: paid.filter((e) => e.access === 'early').length,
    permanent: paid.filter((e) => e.access === 'permanent').length,
    histogram: PRICE_BANDS.map((min, i) => ({
      min,
      max: PRICE_BANDS[i + 1] ?? null,
      versions: paid.filter((e) => e.band === i).length,
    })),
    ecosystems: s.ecosystems.map((key) => ({ key, label: ecosystemLabel(key) })),
    suppressed: s.suppressed,
    builtAt: s.builtAt,
  };
}

export function parseMarketFilters(params: URLSearchParams): MarketFilters {
  const pick = <T extends string>(key: string, allowed: readonly T[]) => {
    const v = params.get(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  const ecosystem = params.get('ecosystem') || undefined;
  return {
    rating: pick('rating', ['sfw', 'nsfw'] as const),
    access: pick('access', ['early', 'permanent'] as const),
    type: pick('type', [...NAMED_TYPES, 'Other'] as const),
    ecosystem: ecosystem && ecosystem.length <= 64 ? ecosystem : undefined,
  };
}
