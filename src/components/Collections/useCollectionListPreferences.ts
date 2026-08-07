import { useLocalStorage } from '@mantine/hooks';
import type { CollectionListView, CollectionSort } from './collection-list.utils';

export function useCollectionListPreferences() {
  const [view, setView] = useLocalStorage<CollectionListView>({
    key: 'collections-list-view',
    defaultValue: 'default',
    getInitialValueInEffect: true,
  });
  const [sort, setSort] = useLocalStorage<CollectionSort>({
    key: 'collections-list-sort',
    defaultValue: 'name-asc',
    getInitialValueInEffect: true,
  });

  return { view, setView, sort, setSort };
}
