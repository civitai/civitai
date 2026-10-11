export type RosterSort = 'hats' | 'points' | 'newest';

/** How long after joining a member wears the NEW badge. */
export const ROSTER_NEW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Rankable = { hatCount: number; points: number; joinedAt: Date };

function sortValue(item: Rankable, sort: RosterSort) {
  if (sort === 'hats') return item.hatCount;
  if (sort === 'points') return item.points;
  return item.joinedAt.getTime();
}

/**
 * The loaded members in the sort's order, each once. Live points move totals in the cache without
 * re-sorting it, and pages are read by offset from an edge cache, so a later page can repeat a
 * member an earlier one held. The sort is stable: members the server ordered as tied keep its order.
 */
export function orderRoster<T extends Rankable & { user: { id: number } }>(
  items: T[],
  sort: RosterSort
) {
  const seen = new Set<number>();
  const once = items.filter((item) => !seen.has(item.user.id) && !!seen.add(item.user.id));
  return once.sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
}

/**
 * Each member's rank in a list already in the sort's order. Ties share the better rank, as the team
 * positions do (`teamPositionsOverTime`), so two members on 4 hats behind one on 5 are both #2.
 */
export function rosterRanks(items: Rankable[], sort: RosterSort) {
  const ranks: number[] = [];
  items.forEach((item, i) => {
    const tied = i > 0 && sortValue(items[i - 1], sort) === sortValue(item, sort);
    ranks.push(tied ? ranks[i - 1] : i + 1);
  });
  return ranks;
}

export function isNewMember(joinedAt: Date, now: Date) {
  return now.getTime() - joinedAt.getTime() < ROSTER_NEW_MS;
}

export function daysOnTeam(joinedAt: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - joinedAt.getTime()) / DAY_MS));
}

/**
 * The shop's price points among the hats in view, cheapest first. A hat's tier is its place in this
 * list plus one, as the shop shelf ranks its tiles; the free join hat (no price) is tier 0.
 */
export function rosterPricePoints(hatLists: { price: number | null }[][]) {
  const prices = new Set<number>();
  for (const hats of hatLists) for (const { price } of hats) if (price != null) prices.add(price);
  return [...prices].sort((a, b) => a - b);
}

export function hatTier(price: number | null, prices: number[]) {
  if (price == null) return 0;
  return prices.indexOf(price) + 1;
}

/** The tier whose hats wear the gold dot: the dearest of the shop's three. */
export const GOLD_TIER = 3;

/**
 * How a row of `slots` tiles shows `count` hats: all of them when they fit, otherwise one slot fewer
 * and a "+N" tile for the rest.
 */
export function slotPlan(count: number, slots: number) {
  if (count <= slots) return { shown: count, more: 0 };
  const shown = Math.max(0, slots - 1);
  return { shown, more: count - shown };
}

type CardHat = { cosmeticId: number; name: string; url: string | null; worn: boolean };

/**
 * The podium hero and the hats left for its mini row. The hero is the worn hat, else the dearest
 * (the hat list is in shelf order: worn, then dearest, then newest), else nothing.
 */
export function podiumHero<T extends CardHat>(hats: T[]) {
  const withArt = hats.filter((h) => !!h.url);
  const hero = withArt[0];
  if (!hero) return { hero: undefined, label: 'none' as const, rest: [] as T[] };
  return {
    hero,
    label: hero.worn ? ('wearing' as const) : ('top' as const),
    rest: withArt.slice(1),
  };
}
