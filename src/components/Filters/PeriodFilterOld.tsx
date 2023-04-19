import { MetricTimeframe } from '@prisma/client';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { splitUppercase } from '~/utils/string-helpers';

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter() {
  const period = useFiltersContext((state) => state.posts.period);
  const setFilters = useFiltersContext((state) => state.setPostFilters);

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setFilters({ period })}
      value={period}
    />
  );
}
