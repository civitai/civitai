// Filtered out of the default view, not dropped — one toggle brings them back.
//
// 🔴 Filter in SQL, never over a fetched page: `getModActivity` limits four queries and merges them,
// so filtering the result narrows a window that was already truncated by the rows being filtered out.
// An account carrying 100 crowd votes since its last removal then reads as never enforced against, on
// the screen where the next strike is decided.
//
// `setNsfwLevel` is deliberately NOT here: `updateImageNsfwLevel` records it, and that is how the
// ingestion-error, ratings and downleveled queues BLOCK an image. It reads as a rating and is
// sometimes an enforcement action.
export const RATING_ACTIVITIES = [
  // Knights of New Order crowd votes — not a moderator's decision at all, and a busy image carries several.
  'setNsfwLevelKono',
  'ratingReview',
  'moderateTag',
  'disableTag',
  'addTag',
  'deleteTag',
];

/** Activities whose second segment is a verb rather than a value, a count or an id — `buzz:send` and
 *  `buzz:deduct` are two decisions and must not share a row. */
export const DIRECTIONAL_ACTIVITIES = new Set(['buzz', 'comments', 'reviews']);

/** The filter key for an activity. A directional family's trailing segments are amounts, counts or
 *  reasons, so `buzz:send:green:Reward:100000` files under `buzz:send`; every other activity stays
 *  whole, because `minor:true` and `minor:false` are opposite decisions. */
export function activityGroup(activity: string) {
  const [name, second] = activity.split(':');
  return second && DIRECTIONAL_ACTIVITIES.has(name) ? `${name}:${second}` : activity;
}

/** True for a key `activityGroup` produces for a directional family (`buzz:send`), which matches its
 *  parameterised members; false for anything else, including a bare `buzz`. */
export function isFamilyGroup(key: string) {
  const [name, second, ...rest] = key.split(':');
  return !!second && !rest.length && DIRECTIONAL_ACTIVITIES.has(name);
}

/** `at` is the row's `createdAt` as Postgres prints it, never a JS `Date`: the column has no time zone,
 *  and a Date round-trip shifts it by the host's offset wherever the reader and the parameter
 *  serialiser disagree — every page then repeats the first. */
export type ModActivityCursor = { at: string; id: number };

/** One filter option: an `activityGroup` key on one entity type, counted over the whole history. */
export type ModActivityCount = { activity: string; entityType: string; count: number };

/** Camel-cased enum values read as identifiers in a list a moderator scans. */
export const activityLabel = (activity: string) =>
  activity.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
