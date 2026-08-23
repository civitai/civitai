import { ImageSort } from '~/server/common/enums';
import type { FilterSubTypes } from '~/providers/FiltersProvider';

export type SortAvailability = {
  isModerator: boolean;
  canViewNsfw: boolean;
  showNsfw: boolean;
  /** Callers that answer for the level themselves, so the rule below does not apply. */
  ignoreNsfwLevel?: boolean;
};

export function isSortAvailable(
  { type, value }: { type: FilterSubTypes; value: string },
  { isModerator, canViewNsfw, showNsfw, ignoreNsfwLevel }: SortAvailability
) {
  if (ignoreNsfwLevel || isModerator) return true;
  if (!canViewNsfw && (value === 'Newest' || value === 'Oldest')) return false;
  if (type === 'images' && !showNsfw && value === 'Newest') return false;
  return true;
}

// The feeds whose sort is resolved on read. The rule below withholds Newest and
// Oldest from every feed type, but it exists because a freshly posted IMAGE may
// not be rated yet — so a feed of anything else keeps whatever it holds.
const resolvedSortTypes: FilterSubTypes[] = ['images', 'videos', 'modelImages'];

/**
 * The sort a viewer is actually served. Filtering the menu options hides a
 * withheld sort from the picker but leaves it selected AND running the query, so
 * every read of an image feed's sort goes through here.
 *
 * Most Reactions rather than the next sort in the menu: it is the one images sort
 * nothing withholds, and reaching for Oldest would put the viewer back in front of
 * what the rule exists to keep away.
 *
 * Resolved on read and never written back, so regaining NSFW browsing returns the
 * feed to the sort its viewer chose.
 */
export function resolveFeedSort<T extends string>(
  { type, value }: { type: FilterSubTypes; value: T },
  availability: SortAvailability
): T | ImageSort.MostReactions {
  if (!resolvedSortTypes.includes(type)) return value;
  return isSortAvailable({ type, value }, availability) ? value : ImageSort.MostReactions;
}
