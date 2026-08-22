import { useSortAvailability } from '~/components/Filters/useSortAvailability';
import { resolveHubSort } from '~/components/Hubs/hub-sort';

export function useHubSort(stored: unknown) {
  return resolveHubSort(stored, useSortAvailability());
}
