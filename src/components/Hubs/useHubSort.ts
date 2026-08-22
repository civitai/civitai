import { useSortAvailability } from '~/components/Filters/useSortAvailability';
import { defaultHubSort, resolveHubSort } from '~/components/Hubs/hub-sort';

export function useHubSort(stored: unknown) {
  return resolveHubSort(stored, useSortAvailability());
}

export function useDefaultHubSort() {
  return defaultHubSort(useSortAvailability());
}
