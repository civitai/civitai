import { useLocalStorage } from '@mantine/hooks';
import { useCallback } from 'react';
import type {
  CollectionListView,
  CollectionMembership,
  CollectionSort,
} from './collection-list.utils';

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

  const [collapsed, setCollapsed] = useLocalStorage<CollectionMembership[]>({
    key: 'collections-list-collapsed',
    defaultValue: [],
    getInitialValueInEffect: true,
  });

  const toggleSection = useCallback(
    (key: CollectionMembership) =>
      setCollapsed((current) =>
        current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
      ),
    [setCollapsed]
  );

  return { view, setView, sort, setSort, collapsed, toggleSection };
}
