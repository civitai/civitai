import { MetricTimeframe } from '@prisma/client';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';

type PeriodFilterProps = {
  type: FilterSubTypes;
};

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter({ type }: PeriodFilterProps) {
  const period = useFiltersContext((state) => state[type].period);
  const setFilters = useSetFilters(type);

  return (
    <IsClient>
      <SelectMenu
        label={period}
        options={periodOptions.map((x) => ({ label: x, value: x }))}
        onClick={(period) => setFilters({ period: period as any })}
        value={period}
      />
    </IsClient>
  );
}
