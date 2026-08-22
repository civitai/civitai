export type SortAvailability = {
  isModerator: boolean;
  canViewNsfw: boolean;
  showNsfw: boolean;
};

export function isSortAvailable(
  { type, value }: { type: string; value: string },
  { isModerator, canViewNsfw, showNsfw }: SortAvailability
) {
  if (isModerator) return true;
  if (!canViewNsfw && (value === 'Newest' || value === 'Oldest')) return false;
  if (type === 'images' && !showNsfw && value === 'Newest') return false;
  return true;
}
