import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterKeys, useFiltersContext } from '~/providers/FiltersProvider';
import { ImageSort as ImageSortOptions } from '~/server/common/enums';
import { useCallback } from 'react';
import { IsClient } from '~/components/IsClient/IsClient';

type SortTypes = FilterKeys<'images' | 'modelImages'>;
type SortFilterProps = {
  type: SortTypes;
};

export function ImageSort({ type }: SortFilterProps) {
  const sortOptions = Object.values(ImageSortOptions);
  const sort = useFiltersContext((state) => state[type].sort);
  const setFilters = useFiltersContext(
    useCallback(
      (state) => (type === 'images' ? state.setImageFilters : state.setModelImageFilters),
      [type]
    )
  );
  return (
    <IsClient>
      <SelectMenu
        label={sort}
        options={sortOptions.map((x) => ({ label: x, value: x }))}
        onClick={(sort) => setFilters({ sort })}
        value={sort}
      />
    </IsClient>
  );
}
