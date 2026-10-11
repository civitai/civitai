export type RosterSort = 'hats' | 'points' | 'newest';

type Standing = { hatCount: number; points: number; joinedAt: Date };
type StandingField = 'hatCount' | 'points' | 'joined';

// Each sort's full key, every field highest first. The member's id breaks what is left, so no two
// members ever sit in an undefined order: the server's page and the client's re-sort agree.
const STANDING_KEYS: Record<RosterSort, StandingField[]> = {
  hats: ['hatCount', 'points', 'joined'],
  points: ['points', 'hatCount', 'joined'],
  newest: ['joined', 'points'],
};

const fieldValue = (item: Standing, field: StandingField) =>
  field === 'joined' ? item.joinedAt.getTime() : item[field];

/** Orders two members by the sort's full key, without the id. Zero means an exact tie. */
export function compareStanding(a: Standing, b: Standing, sort: RosterSort) {
  for (const field of STANDING_KEYS[sort]) {
    const diff = fieldValue(b, field) - fieldValue(a, field);
    if (diff) return diff;
  }
  return 0;
}

/** A comparator for `Array.sort`: the full key, then the lower member id first. */
export function rosterComparator<T extends Standing>(sort: RosterSort, idOf: (item: T) => number) {
  return (a: T, b: T) => compareStanding(a, b, sort) || idOf(a) - idOf(b);
}
