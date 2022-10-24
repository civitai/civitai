import { useModelStore } from '~/hooks/useModelStore';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { MetricTimeframe } from '@prisma/client';
import { splitUppercase } from './../../utils/string-helpers';

const periodOptions = Object.values(MetricTimeframe);

export function ListPeriod() {
  const period = useModelStore((state) => state.filters.period);
  const setPeriod = useModelStore((state) => state.setPeriod);

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={setPeriod}
      value={period}
    />
  );
}
