import { MetricTimeframe } from '@prisma/client';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterKeys, useFiltersContext } from '~/providers/FiltersProvider';
import { useCallback } from 'react';
import { splitUppercase } from '~/utils/string-helpers';
import { IsClient } from '~/components/IsClient/IsClient';

type SortTypes = FilterKeys<'images' | 'modelImages'>;
type SortFilterProps = {
  type: SortTypes;
};

const periodOptions = Object.values(MetricTimeframe);
export function ImagePeriod({ type }: SortFilterProps) {
  const period = useFiltersContext((state) => state[type].period);
  const setFilters = useFiltersContext(
    useCallback(
      (state) => (type === 'images' ? state.setImageFilters : state.setModelImageFilters),
      [type]
    )
  );
  return (
    <IsClient>
      <SelectMenu
        label={splitUppercase(period.toString())}
        options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
        onClick={(period) => setFilters({ period })}
        value={period}
      />
    </IsClient>
  );
}
