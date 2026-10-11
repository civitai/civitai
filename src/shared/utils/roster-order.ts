export type RosterSort = 'hats' | 'points' | 'newest';

type Standing = { hatCount: number; points: number; joinedAt: Date };
type StandingField = 'hatCount' | 'points' | 'joined';

// Each sort's full key, every field highest first: the order the server's rank sets score
// (roster-score.ts), so a page and the client's re-sort agree. Join time counts by the minute, as
// the rank score packs it.
const STANDING_KEYS: Record<RosterSort, StandingField[]> = {
  hats: ['hatCount', 'points', 'joined'],
  points: ['points', 'hatCount', 'joined'],
  newest: ['joined', 'points'],
};

export const MINUTE_MS = 60 * 1000;
const fieldValue = (item: Standing, field: StandingField) =>
  field === 'joined' ? Math.floor(item.joinedAt.getTime() / MINUTE_MS) : item[field];

/** Orders two members by the sort's full key, without the id. Zero means an exact tie. */
export function compareStanding(a: Standing, b: Standing, sort: RosterSort) {
  for (const field of STANDING_KEYS[sort]) {
    const diff = fieldValue(b, field) - fieldValue(a, field);
    if (diff) return diff;
  }
  return 0;
}

/**
 * A comparator for `Array.sort`: the full key, then the member id as Redis orders equal scores in a
 * reversed range, by its string, highest first ("9" before "10").
 */
export function rosterComparator<T extends Standing>(sort: RosterSort, idOf: (item: T) => number) {
  return (a: T, b: T) => {
    const byStanding = compareStanding(a, b, sort);
    if (byStanding) return byStanding;
    const [x, y] = [String(idOf(a)), String(idOf(b))];
    return x === y ? 0 : x > y ? -1 : 1;
  };
}
