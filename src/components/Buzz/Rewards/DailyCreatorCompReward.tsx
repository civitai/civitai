import React from 'react';
import {
  Button,
  Center,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
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
const CASH_COLOR = '#26a269';

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
  const [source, setSource] = useState<'compensation' | 'licenseFee'>('compensation');
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data, isLoading } = trpc.buzz.getDailyBuzzCompensation.useQuery(
    { date: selectedDate, accountType: buzzAccountType, source },
    { enabled: features.buzz }
  );
  const resources = data?.resources ?? [];
  const hasPublishedResources = data?.hasPublishedResources ?? false;

  const { data: licenseProbe } = trpc.buzz.getDailyBuzzCompensation.useQuery(
    { date: selectedDate, source: 'licenseFee' },
    { enabled: features.buzz && source === 'compensation' }
  );
  const hasLicenseEarnings = (licenseProbe?.resources.length ?? 0) > 0 || source === 'licenseFee';
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const labelColor = colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];
  const minSelectedDate = dayjs(selectedDate).startOf('month').toDate();
  const maxSelectedDate = dayjs(selectedDate).endOf('month').toDate();

  const hasCashDatasets =
    source === 'licenseFee' && resources.some((r) => (r.cashData?.length ?? 0) > 0);
  const hasBuzzDatasets = resources.some((r) => (r.data?.length ?? 0) > 0);
  const cashOnlyChart = hasCashDatasets && !hasBuzzDatasets;

  const options = useMemo<ChartOptions<'bar'>>(() => {
    return {
      responsive: true,
      aspectRatio: mobile ? 1 : 1.4,
      scales: {
        ...(cashOnlyChart
          ? {}
          : {
              y: {
                stacked: true,
                beginAtZero: true,
                position: 'left' as const,
                ticks: {
                  color: labelColor,
                  callback: abbreviateValue,
                },
                grid: { color: 'rgba(128, 128, 128, 0.1)' },
                title: hasCashDatasets
                  ? { display: true, text: 'Buzz', color: labelColor }
                  : undefined,
              },
            }),
        ...(hasCashDatasets
          ? {
              y1: {
                stacked: true,
                beginAtZero: true,
                position: cashOnlyChart ? ('left' as const) : ('right' as const),
                ticks: {
                  color: labelColor,
                  callback: (val: number | string) => `$${Number(val).toFixed(0)}`,
                },
                grid: cashOnlyChart ? { color: 'rgba(128, 128, 128, 0.1)' } : { display: false },
                title: cashOnlyChart
                  ? undefined
                  : { display: true, text: 'USD', color: labelColor },
              },
            }
          : {}),
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
        legend: { display: hasCashDatasets },
        tooltip: {
          ...chartTooltipDefaults({ accentColor: buzzConfig.color }),
          callbacks: {
            title(tooltipItems) {
              if (!filteredVersionIds.length) return '';
              return tooltipItems[0].dataset.label;
            },
            footer(tooltipItems) {
              return `${formatDate(tooltipItems[0].parsed.x)}`;
            },
            label(tooltipItem) {
              const value = tooltipItem.parsed.y ?? 0;
              const currency = (tooltipItem.dataset as { currency?: 'BUZZ' | 'USD' }).currency;
              if (currency === 'USD') return `$${value.toFixed(2)}`;
              return `${formatCurrencyForDisplay(value, 'BUZZ')}`;
            },
          },
        },
      },
    };
  }, [
    filteredVersionIds.length,
    hasCashDatasets,
    cashOnlyChart,
    labelColor,
    mobile,
    maxSelectedDate,
    minSelectedDate,
    buzzConfig.color,
  ]);

  const datasets = useMemo(() => {
    if (filteredVersionIds.length > 0) {
      const selected = resources.filter((v) => filteredVersionIds.includes(v.id));
      return selected.flatMap((r) => {
        const out = [];
        if (r.data?.length) {
          out.push({
            label: `${r.modelName} - ${r.name}`,
            data: r.data.map((d) => ({ x: d.createdAt, y: d.total })),
            backgroundColor: buzzConfig.color,
            borderColor: buzzConfig.color,
            yAxisID: 'y',
            currency: 'BUZZ' as const,
          });
        }
        if (source === 'licenseFee' && r.cashData?.length) {
          out.push({
            label: `${r.modelName} - ${r.name} (cash)`,
            data: r.cashData.map((d) => ({ x: d.createdAt, y: d.total / 100 })),
            backgroundColor: CASH_COLOR,
            borderColor: CASH_COLOR,
            yAxisID: 'y1',
            currency: 'USD' as const,
          });
        }
        return out;
      });
    }

    const aggregate = (rows: { createdAt: string; total: number }[]) =>
      Array.from(
        rows
          .reduce(
            (acc, r) => acc.set(r.createdAt, (acc.get(r.createdAt) ?? 0) + r.total),
            new Map<string, number>()
          )
          .entries()
      );

    const out = [];
    const buzzAgg = aggregate(resources.flatMap((r) => r.data ?? []));
    if (buzzAgg.length) {
      out.push({
        label: 'Buzz',
        data: buzzAgg.map(([x, y]) => ({ x, y })),
        backgroundColor: buzzConfig.color,
        borderColor: buzzConfig.color,
        yAxisID: 'y',
        currency: 'BUZZ' as const,
      });
    }
    if (source === 'licenseFee') {
      const cashAgg = aggregate(resources.flatMap((r) => r.cashData ?? []));
      if (cashAgg.length) {
        out.push({
          label: 'Cash',
          data: cashAgg.map(([x, y]) => ({ x, y: y / 100 })),
          backgroundColor: CASH_COLOR,
          borderColor: CASH_COLOR,
          yAxisID: 'y1',
          currency: 'USD' as const,
        });
      }
    }
    return out;
  }, [filteredVersionIds, resources, buzzConfig.color, source]);

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
  const { totalBuzz, totalCashCents } = combinedResources.reduce(
    (acc, r) => {
      if (filteredVersionIds.length > 0 && !filteredVersionIds.includes(r.id)) return acc;
      acc.totalBuzz += r.totalSum;
      acc.totalCashCents += r.cashCents ?? 0;
      return acc;
    },
    { totalBuzz: 0, totalCashCents: 0 }
  );
  const showCashTotal = source === 'licenseFee' && totalCashCents > 0;
  // Established creators (any published resource) keep the two-column layout even on a
  // zero-earning month, so the month selector doesn't jump between months.
  const useTwoColLayout = !isLoading && (resources.length > 0 || hasPublishedResources);

  return (
    <>
      <div
        className={classes.dashboardGrid}
        style={
          {
            '--grid-cols': useTwoColLayout ? 'minmax(0, 8fr) minmax(0, 4fr)' : 'minmax(0, 1fr)',
          } as React.CSSProperties
        }
      >
        <Paper
          className={classes.tileCard}
          style={{
            overflow: 'hidden',
            display: 'grid',
            gridTemplateRows: 'auto 1fr',
            minHeight: 0,
          }}
        >
          {/* Header — always padded */}
          <Stack gap={0} p="md" pb={0}>
            <Group gap={8} justify="space-between">
              <h3 className="text-xl font-bold">
                {source === 'licenseFee' ? 'License Fees Earned' : 'Generation Buzz Earned'}
              </h3>
              <Group gap={8} wrap="nowrap">
                {hasLicenseEarnings && (
                  <SegmentedControl
                    value={source}
                    onChange={(value) => {
                      setSource(value as 'compensation' | 'licenseFee');
                      setSearch('');
                      setFilteredVersionIds([]);
                    }}
                    data={[
                      { value: 'compensation', label: 'Compensation' },
                      { value: 'licenseFee', label: 'License Fees' },
                    ]}
                    size="xs"
                  />
                )}
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
            </Group>
            {!isLoading && resources.length > 0 && (
              <Group justify="flex-start" gap="md" wrap="nowrap">
                {totalBuzz > 0 && (
                  <Group gap={4} wrap="nowrap">
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
                {showCashTotal && (
                  <Text size="xl" c={CASH_COLOR} fw="bold" style={{ fontVariant: 'tabular-nums' }}>
                    ${formatCurrencyForDisplay(totalCashCents, Currency.USD)}
                  </Text>
                )}
              </Group>
            )}
          </Stack>
          {/* Content */}
          {!isLoading && resources.length > 0 ? (
            <div
              style={{
                position: 'relative',
                width: '100%',
                minHeight: 300,
                padding: 'var(--mantine-spacing-md)',
              }}
            >
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
              mode={hasPublishedResources ? 'noEarningsThisMonth' : 'onboarding'}
            />
          )}
        </Paper>
        {useTwoColLayout && (
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
              <h3 className="text-xl font-bold">Top Earning Resources</h3>
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
                  borderTop:
                    '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
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
                            borderBottom:
                              '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
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
                            <Stack gap={2} align="flex-end">
                              {(version.totalSum > 0 || source !== 'licenseFee') && (
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
                              )}
                              {source === 'licenseFee' && (version.cashCents ?? 0) > 0 && (
                                <Text size="xs" fw="bold" style={{ fontVariant: 'tabular-nums' }}>
                                  ${formatCurrencyForDisplay(version.cashCents ?? 0, Currency.USD)}
                                </Text>
                              )}
                            </Stack>
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
