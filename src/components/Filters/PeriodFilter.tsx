import { Chip, createStyles } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { useCallback } from 'react';
import { PeriodModeToggle } from '~/components/Filters/PeriodModeToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import {
  FilterSubTypes,
  hasPeriodMode,
  PeriodModeType,
  useFiltersContext,
  useSetFilters,
} from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { getDisplayName } from '~/utils/string-helpers';

type PeriodFilterProps = StatefulProps | DumbProps;

const periodOptions = Object.values(MetricTimeframe);
export function PeriodFilter(props: PeriodFilterProps) {
  if (props.value) return <DumbPeriodFilter {...props} />;
  return <StatefulPeriodFilter {...props} type={props.type} />;
}

const useStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.white,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: 'transparent',
      },
    },
  },
}));

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
  const { classes } = useStyles();
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
        <Chip.Group spacing={8} value={value} onChange={onChange}>
          {options.map((x, index) => (
            <Chip
              key={index}
              value={x.value}
              classNames={classes}
              size="sm"
              radius="xl"
              variant="filled"
              tt="capitalize"
            >
              {x.label}
            </Chip>
          ))}
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
    useCallback((state) => (type !== 'collections' ? state[type].period : undefined), [type])
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
