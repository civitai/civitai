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
