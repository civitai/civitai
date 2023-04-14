import { MetricTimeframe } from '@prisma/client';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useFiltersContext } from '~/providers/FiltersProviderOld';
import { splitUppercase } from '~/utils/string-helpers';

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter() {
  const period = useFiltersContext((state) => state.period);
  const setFilters = useFiltersContext((state) => state.setFilters);

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setFilters({ period })}
      value={period}
    />
  );
}
