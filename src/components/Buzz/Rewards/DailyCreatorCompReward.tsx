import React from 'react';
import {
  Button,
  Center,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
  rgba,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ChartOptions } from 'chart.js';
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Colors,
  Legend,
  LinearScale,
  PointElement,
  TimeScale,
  Tooltip as ChartTooltip,
} from 'chart.js';
import 'chartjs-adapter-dayjs-4/dist/chartjs-adapter-dayjs-4.esm';
import dayjs from '~/shared/utils/dayjs';
import { useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import classes from '~/components/Buzz/buzz.module.scss';
import { abbreviateValue, chartTooltipDefaults } from '~/components/Buzz/chart-defaults';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ClearableTextInput } from '~/components/ClearableTextInput/ClearableTextInput';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate, getDatesAsList, stripTime } from '~/utils/date-helpers';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { GenerationBuzzEmptyState } from './GenerationBuzzEmptyState';
import { getAccountTypeLabel } from '~/utils/buzz';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  BarElement,
  ChartTooltip,
  Colors,
  Legend,
  TimeScale
);

const now = dayjs();
const startDate = dayjs('2024-08-01').toDate();
const monthsUntilNow = getDatesAsList(startDate, now.toDate(), 'month');

// get date options as month from start of year to now
const dateOptions = monthsUntilNow.reverse().map((month) => {
  const date = dayjs(month).startOf('month').add(15, 'day');
  return {
    value: stripTime(date.toDate()),
    label: date.format('MMMM YYYY'),
  };
});

export function DailyCreatorCompReward({
  buzzAccountType = 'yellow',
}: {
  buzzAccountType?: BuzzSpendType;
}) {
  const features = useFeatureFlags();
  const buzzConfig = useBuzzCurrencyConfig(buzzAccountType);
  const mobile = useIsMobile({ breakpoint: 'sm' });
  const [filteredVersionIds, setFilteredVersionIds] = useState<number[]>([]);
  const [selectedDate, setSelectedDate] = useState(dateOptions[0].value);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data: resources = [], isLoading } = trpc.buzz.getDailyBuzzCompensation.useQuery(
    { date: selectedDate, accountType: buzzAccountType },
    { enabled: features.buzz }
  );
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const labelColor = colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];
  const minSelectedDate = dayjs(selectedDate).startOf('month').toDate();
  const maxSelectedDate = dayjs(selectedDate).endOf('month').toDate();

  const options = useMemo<ChartOptions<'bar'>>(
    () => {
      return {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: {
              color: labelColor,
              callback: abbreviateValue,
            },
            grid: { color: 'rgba(128, 128, 128, 0.1)' },
          },
          x: {
            stacked: true,
            type: 'time' as const,
            min: minSelectedDate.valueOf(),
            max: maxSelectedDate.valueOf(),
            time: { tooltipFormat: 'YYYY-MM-DD' },
            ticks: {
              color: labelColor,
              maxTicksLimit: mobile ? 5 : 8,
              autoSkip: true,
            },
            grid: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...chartTooltipDefaults({
              accentColor: buzzConfig.color,
              formatValue: (val) => formatCurrencyForDisplay(val, 'BUZZ'),
            }),
            callbacks: {
              title(tooltipItems) {
                if (!filteredVersionIds.length) return '';
                return tooltipItems[0].dataset.label;
              },
              footer(tooltipItems) {
                return `${formatDate(tooltipItems[0].parsed.x)}`;
              },
              label(tooltipItem) {
                return `${formatCurrencyForDisplay(tooltipItem.parsed.y ?? 0, 'BUZZ')}`;
              },
            },
          },
        },
      };
    },
    [filteredVersionIds.length, labelColor, mobile, maxSelectedDate, minSelectedDate, buzzConfig.color]
  );

  const datasets = useMemo(() => {
    if (filteredVersionIds.length > 0) {
      const data = resources.filter((v) => filteredVersionIds.includes(v.id));

      return data.map((resource) => ({
        label: `${resource.modelName} - ${resource.name}`,
        data: (resource.data ?? []).map((data) => ({ x: data.createdAt, y: data.total })),
      }));
    }

    const data = resources
      .flatMap((resource) => resource.data)
      .reduce((acc, resource) => {
        const existing = acc.find((x) => x.createdAt === resource.createdAt);
        if (existing) existing.total += resource.total;
        else acc.push({ ...resource });

        return acc;
      }, [] as { createdAt: string; total: number }[]);

    return [
      {
        backgroundColor: buzzConfig.color,
        borderColor: buzzConfig.color,
        data: data.map((resource) => ({ x: resource.createdAt, y: resource.total })),
      },
    ];
  }, [filteredVersionIds, resources, buzzConfig.color]);

  const selectedResources = resources.filter((v) => filteredVersionIds.includes(v.id));
  const combinedResources = [
    ...selectedResources,
    ...resources.filter((v) => !filteredVersionIds.includes(v.id)),
  ];
  const filteredResources = debouncedSearch
    ? combinedResources.filter((v) =>
        v.modelName.toLowerCase().includes(debouncedSearch.trim().toLowerCase())
      )
    : combinedResources.slice(0, 20);
  const totalBuzz = combinedResources.reduce((acc, resource) => {
    if (filteredVersionIds.length > 0 && !filteredVersionIds.includes(resource.id)) return acc;

    return acc + resource.totalSum;
  }, 0);

  return (
    <>
      <div
        className={classes.dashboardGrid}
        style={{
          '--grid-cols': !isLoading && resources.length > 0
            ? 'minmax(0, 8fr) minmax(0, 4fr)'
            : 'minmax(0, 1fr)',
        } as React.CSSProperties}
      >
          <Paper className={classes.tileCard} style={{ overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
            {/* Header — always padded */}
            <Stack gap={0} p="md" pb={0}>
              <Group gap={8} justify="space-between">
                <h3 className="text-xl font-bold">Generation Buzz Earned</h3>
                <Select
                  data={dateOptions}
                  defaultValue={dateOptions[0].value}
                  onChange={(value) => {
                    setSelectedDate(
                      dateOptions.find((x) => x.value === value)?.value ?? selectedDate
                    );
                    setSearch('');
                    setFilteredVersionIds([]);
                  }}
                />
              </Group>
              {!isLoading && resources.length > 0 && (
                <Group justify="flex-start" gap={4}>
                  <CurrencyIcon currency={Currency.BUZZ} size={24} type={buzzAccountType} />
                  <Text
                    size="xl"
                    c={buzzConfig.color}
                    fw="bold"
                    style={{ fontVariant: 'tabular-nums' }}
                  >
                    {formatCurrencyForDisplay(totalBuzz, Currency.BUZZ)}
                  </Text>
                </Group>
              )}
            </Stack>
            {/* Content */}
            {!isLoading && resources.length > 0 ? (
              <div style={{ position: 'relative', height: '100%', width: '100%', padding: 'var(--mantine-spacing-md)' }}>
                <Bar
                  key={filteredVersionIds.join('-')}
                  options={options}
                  data={{
                    // labels,
                    datasets,
                  }}
                />
              </div>
            ) : (
              <GenerationBuzzEmptyState
                buzzColor={buzzConfig.color}
                buzzLabel={getAccountTypeLabel(buzzAccountType)}
                loading={isLoading}
              />
            )}
          </Paper>
        {!isLoading && resources.length > 0 && (
            <Paper
              className={classes.tileCard}
              h="100%"
              radius="md"
              style={{
                display: 'grid',
                gridTemplateRows: 'auto 1fr',
                overflow: 'hidden',
                padding: 'var(--mantine-spacing-lg) var(--mantine-spacing-lg) 0',
              }}
            >
              <Stack gap={8} pb="sm">
                <h3 className="text-xl font-bold">
                  Top Earning Resources
                </h3>
                <ClearableTextInput
                  placeholder="Search your resources"
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                />
              </Stack>
                {filteredResources.length > 0 ? (
                  <div
                    className={classes.transactionsScrollWrapper}
                    style={{
                      position: 'relative',
                      marginLeft: 'calc(-1 * var(--mantine-spacing-lg))',
                      marginRight: 'calc(-1 * var(--mantine-spacing-lg))',
                      borderTop: '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
                    }}
                  >
                    {filteredVersionIds.length > 0 && (
                      <Button
                        variant="filled"
                        color="dark"
                        radius="xl"
                        size="compact-xs"
                        onClick={() => setFilteredVersionIds([])}
                        style={{
                          position: 'absolute',
                          top: 8,
                          left: '50%',
                          transform: 'translateX(-50%)',
                          zIndex: 2,
                          boxShadow: 'var(--mantine-shadow-sm)',
                        }}
                        px="md"
                      >
                        Clear selection
                      </Button>
                    )}
                    <ScrollArea.Autosize
                      mah={400}
                      style={{ width: '100%', overflow: 'hidden' }}
                      type="auto"
                      className="[&>*]:w-full"
                    >
                      <div style={{ paddingBottom: 'var(--mantine-spacing-lg)' }}>
                        {filteredResources.map((version) => {
                          const isSelected = filteredVersionIds.includes(version.id);

                          return (
                            <UnstyledButton
                              key={version.id}
                              py="xs"
                              px="lg"
                              style={{
                                backgroundColor: isSelected ? rgba(buzzConfig.color, 0.1) : undefined,
                                borderBottom: '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
                              }}
                              onClick={() => {
                                setFilteredVersionIds((ids) =>
                                  isSelected
                                    ? ids.filter((id) => id !== version.id)
                                    : [...ids, version.id]
                                );
                                setSearch('');
                              }}
                              w="100%"
                            >
                              <Group justify="space-between" gap={8} wrap="nowrap">
                                <Stack gap={0}>
                                  <Text size="sm" fw="bold" lineClamp={1}>
                                    {version.modelName}
                                  </Text>
                                  <Text size="xs" c="dimmed" lineClamp={1}>
                                    {version.name}
                                  </Text>
                                </Stack>
                                <Group gap={4} wrap="nowrap">
                                  <CurrencyIcon
                                    currency={Currency.BUZZ}
                                    size={16}
                                    type={buzzAccountType}
                                  />
                                  <Text
                                    size="sm"
                                    c={buzzConfig.color}
                                    fw="bold"
                                    style={{ fontVariant: 'tabular-nums' }}
                                  >
                                    {formatCurrencyForDisplay(version.totalSum, Currency.BUZZ)}
                                  </Text>
                                </Group>
                              </Group>
                            </UnstyledButton>
                          );
                        })}
                      </div>
                    </ScrollArea.Autosize>
                  </div>
                ) : (
                  <Center px="lg" pb="lg">
                    <Text c="dimmed">
                      {debouncedSearch && !filteredResources.length
                        ? 'No resources found. Try changing your search terms'
                        : 'No earning resources yet'}
                    </Text>
                  </Center>
                )}
            </Paper>
        )}
      </div>
    </>
  );
}

