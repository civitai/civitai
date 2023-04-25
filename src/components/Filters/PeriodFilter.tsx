import { MetricTimeframe } from '@prisma/client';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import { getDisplayName } from '~/utils/string-helpers';

type PeriodFilterProps = StatefulProps | DumbProps;

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter(props: PeriodFilterProps) {
  if (props.value) return <DumbPeriodFilter {...props} />;
  return <StatefulPeriodFilter type={props.type} disabled={props.disabled} />;
}

type DumbProps = {
  value: MetricTimeframe;
  onChange: (value: MetricTimeframe) => void;
  disabled?: boolean;
};
function DumbPeriodFilter({ value, onChange, disabled }: DumbProps) {
  return (
    <IsClient>
      <SelectMenu
        label={getDisplayName(value)}
        options={periodOptions.map((x) => ({ label: getDisplayName(x), value: x }))}
        onClick={onChange}
        value={value}
        disabled={disabled}
      />
    </IsClient>
  );
}

type StatefulProps = {
  type: FilterSubTypes;
  disabled?: boolean;
  value?: undefined;
  onChange?: undefined;
};
function StatefulPeriodFilter({ type, disabled }: StatefulProps) {
  const period = useFiltersContext((state) => state[type].period);
  const setFilters = useSetFilters(type);

  return (
    <DumbPeriodFilter
      value={period}
      onChange={(period) => setFilters({ period })}
      disabled={disabled}
    />
  );
}
