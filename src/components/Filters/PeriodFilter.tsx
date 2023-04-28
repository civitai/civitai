import { MetricTimeframe } from '@prisma/client';
import { PeriodModeToggle } from '~/components/Filters/PeriodModeToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import {
  FilterSubTypes,
  hasPeriodMode,
  PeriodModeTypes,
  useFiltersContext,
  useSetFilters,
} from '~/providers/FiltersProvider';
import { getDisplayName } from '~/utils/string-helpers';

type PeriodFilterProps = StatefulProps | DumbProps;

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter(props: PeriodFilterProps) {
  if (props.value) return <DumbPeriodFilter {...props} />;
  return <StatefulPeriodFilter type={props.type} disabled={props.disabled} />;
}

type DumbProps = {
  type: FilterSubTypes;
  value: MetricTimeframe;
  onChange: (value: MetricTimeframe) => void;
  disabled?: boolean;
  hideMode?: boolean;
};
function DumbPeriodFilter({ value, onChange, disabled, type, hideMode }: DumbProps) {
  const showPeriodMode = !hideMode && hasPeriodMode(type);

  return (
    <IsClient>
      <SelectMenu
        label={getDisplayName(value)}
        options={periodOptions.map((x) => ({ label: getDisplayName(x), value: x }))}
        onClick={onChange}
        value={value}
        disabled={disabled}
      >
        {showPeriodMode && <PeriodModeToggle type={type as PeriodModeTypes} />}
      </SelectMenu>
    </IsClient>
  );
}

type StatefulProps = {
  type: FilterSubTypes;
  disabled?: boolean;
  value?: undefined;
  onChange?: undefined;
  hideMode?: boolean;
};
function StatefulPeriodFilter({ type, disabled, hideMode }: StatefulProps) {
  const period = useFiltersContext((state) => state[type].period);
  const setFilters = useSetFilters(type);

  return (
    <DumbPeriodFilter
      type={type}
      value={period}
      onChange={(period) => setFilters({ period })}
      disabled={disabled}
      hideMode={hideMode}
    />
  );
}
