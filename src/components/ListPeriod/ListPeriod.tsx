import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { MetricTimeframe } from '@prisma/client';
import { splitUppercase } from './../../utils/string-helpers';
import { useModelFilters } from '~/hooks/useModelFilters';

const periodOptions = Object.values(MetricTimeframe);

export function ListPeriod() {
  const {
    filters: { period },
    setFilters,
  } = useModelFilters();

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setFilters((state) => ({ ...state, period }))}
      value={period}
    />
  );
}
