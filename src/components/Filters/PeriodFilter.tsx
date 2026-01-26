import { Chip, Group } from '@mantine/core';
import { useRouter } from 'next/router';
import { useCallback } from 'react';
import { FilterChip } from '~/components/Filters/FilterChip';
import { PeriodModeToggle } from '~/components/Filters/PeriodModeToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import type { FilterSubTypes, PeriodModeType } from '~/providers/FiltersProvider';
import { hasPeriodMode, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { getDisplayName } from '~/utils/string-helpers';

type PeriodFilterProps = StatefulProps | DumbProps;

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter(props: PeriodFilterProps) {
  if (props.value) return <DumbPeriodFilter {...props} />;
  return <StatefulPeriodFilter {...props} type={props.type} />;
}

type DumbProps = {
  type: FilterSubTypes;
  value: MetricTimeframe;
  onChange: (value: MetricTimeframe) => void;
  disabled?: boolean;
  hideMode?: boolean;
  variant?: 'menu' | 'chips';
};
function DumbPeriodFilter({
  value,
  onChange,
  disabled,
  type,
  hideMode,
  variant = 'menu',
}: DumbProps) {
  const showPeriodMode = !hideMode && hasPeriodMode(type);
  const options = periodOptions.map((x) => ({ label: getDisplayName(x), value: x }));

  return (
    <IsClient>
      {variant === 'menu' && (
        <SelectMenu
          label={getDisplayName(value)}
          options={options}
          onClick={onChange}
          value={value}
          disabled={disabled}
        >
          {showPeriodMode && <PeriodModeToggle type={type as PeriodModeType} />}
        </SelectMenu>
      )}
      {variant === 'chips' && (
        <Chip.Group value={value} onChange={(v) => onChange(v as MetricTimeframe)}>
          <Group gap={8}>
            {options.map((x, index) => (
              <FilterChip key={index} value={x.value}>
                <span>{x.label}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      )}
    </IsClient>
  );
}

type StatefulProps = {
  type: FilterSubTypes;
  disabled?: boolean;
  value?: undefined;
  onChange?: undefined;
  hideMode?: boolean;
  variant?: 'menu' | 'chips';
};
function StatefulPeriodFilter({ type, disabled, hideMode, variant }: StatefulProps) {
  const { query, pathname, replace } = useRouter();

  const globalPeriod = useFiltersContext(
    useCallback(
      (state) =>
        type !== 'collections' &&
        // type !== 'clubs' &&
        type !== 'threads' &&
        type !== 'generation' &&
        type !== 'tools' &&
        type !== 'buzzWithdrawalRequests' &&
        type !== 'crucibles' &&
        type !== 'changelogs' &&
        type !== 'auctions'
          ? state[type].period
          : undefined,
      [type]
    )
  );
  const queryPeriod = query.period as typeof globalPeriod | undefined;

  const setFilters = useSetFilters(type);
  const setPeriod = (period: typeof globalPeriod) => {
    if (queryPeriod && queryPeriod !== period)
      replace({ pathname, query: removeEmpty({ ...query, period: undefined }) }, undefined, {
        shallow: true,
      });

    setFilters({ period: period as any });
  };

  const period = queryPeriod ? queryPeriod : globalPeriod;
  if (!period) return null;
  return (
    <DumbPeriodFilter
      type={type}
      value={period}
      onChange={setPeriod}
      disabled={disabled}
      hideMode={hideMode}
      variant={variant}
    />
  );
}
