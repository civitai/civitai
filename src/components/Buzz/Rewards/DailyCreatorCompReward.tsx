import {
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { Currency, StripeConnectStatus } from '@prisma/client';
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Tooltip as ChartTooltip,
  Colors,
  Legend,
  LinearScale,
  PointElement,
  TimeScale,
} from 'chart.js';
import 'chartjs-adapter-dayjs-4/dist/chartjs-adapter-dayjs-4.esm';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import { useBuzzDashboardStyles } from '~/components/Buzz/buzz.styles';
import { ClearableTextInput } from '~/components/ClearableTextInput/ClearableTextInput';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useUserStripeConnect } from '~/components/Stripe/stripe.utils';
import { getDatesAsList, minDate } from '~/utils/date-helpers';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

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
const monthsUntilNow = getDatesAsList(now.clone().startOf('year').toDate(), now.toDate(), 'month');

// get date options as month from start of year to now
const dateOptions = monthsUntilNow.reverse().map((month) => {
  const date = dayjs(month);
  return {
    value: date.toISOString(),
    label: date.format('MMMM YYYY'),
  };
});

export function DailyCreatorCompReward() {
  const [filteredVersionIds, setFilteredVersionIds] = useState<number[]>([]);
  const [selectedDate, setSelectedDate] = useState(dateOptions[0].value);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { userStripeConnect } = useUserStripeConnect();

  const { data: resources = [], isLoading } = trpc.buzz.getDailyBuzzCompensation.useQuery(
    { date: selectedDate },
    { enabled: userStripeConnect?.status === StripeConnectStatus.Approved }
  );

  const { classes, theme } = useBuzzDashboardStyles();
  const labelColor = theme.colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];
  const minSelectedDate = dayjs(selectedDate).startOf('month').toDate();
  const maxSelectedDate = minDate(dayjs(selectedDate).endOf('month').toDate(), new Date());

  const options = useMemo<ChartOptions<'bar'>>(
    () => ({
      responsive: true,
      scales: {
        y: {
          title: {
            display: true,
            color: labelColor,
          },
          stacked: true,
          suggestedMin: 0,
          ticks: {
            stepSize: 1000,
            color: labelColor,
          },
        },
        x: {
          stacked: true,
          type: 'time',
          min: minSelectedDate.valueOf(),
          max: maxSelectedDate.valueOf(),
          time: { tooltipFormat: 'YYYY-MM-DD' },
          ticks: { color: labelColor },
        },
      },
      plugins: {
        legend: {
          display: false,
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            borderRadius: 5,
            useBorderRadius: true,
            color: labelColor,
          },
        },
        title: { display: false },
        tooltip: {
          callbacks: {
            footer(tooltipItems) {
              if (!filteredVersionIds.length) return;

              const sum = tooltipItems.reduce((acc, item) => acc + item.parsed.y, 0);
              return `⚡️ ${formatCurrencyForDisplay(sum, 'BUZZ')}`;
            },
            label(tooltipItem) {
              return filteredVersionIds.length > 0
                ? `${tooltipItem.dataset.label}`
                : `⚡️ ${formatCurrencyForDisplay(tooltipItem.parsed.y, 'BUZZ')}`;
            },
          },
        },
      },
    }),
    [filteredVersionIds.length, labelColor, maxSelectedDate, minSelectedDate]
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
        data: data.map((resource) => ({ x: resource.createdAt, y: resource.total })),
      },
    ];
  }, [filteredVersionIds, resources]);

  if (userStripeConnect?.status !== StripeConnectStatus.Approved) {
    return null;
  }

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
    <Grid gutter="xs">
      <Grid.Col xs={12} md={8}>
        <Paper withBorder className={classes.tileCard} h="100%">
          <Stack p="md">
            <Stack spacing={0}>
              <Group spacing={8} position="apart">
                <Title order={3}>Generation Buzz Earned</Title>
                <Select
                  data={dateOptions}
                  defaultValue={dateOptions[0].value}
                  onChange={(value) =>
                    setSelectedDate(
                      dateOptions.find((x) => x.value === value)?.value ?? selectedDate
                    )
                  }
                />
              </Group>
              <Group position="left" spacing={4}>
                <CurrencyIcon currency={Currency.BUZZ} size={24} />
                <Text
                  size="xl"
                  color="yellow.7"
                  weight="bold"
                  style={{ fontVariant: 'tabular-nums' }}
                >
                  {formatCurrencyForDisplay(totalBuzz, Currency.BUZZ)}
                </Text>
              </Group>
            </Stack>
            {!isLoading && resources.length > 0 ? (
              <Bar
                key={filteredVersionIds.join('-')}
                options={options}
                data={{
                  // labels,
                  datasets,
                }}
              />
            ) : isLoading ? (
              <Center>
                <Loader />
              </Center>
            ) : (
              <NoData />
            )}
          </Stack>
        </Paper>
      </Grid.Col>
      <Grid.Col xs={12} md={4}>
        <Paper className={classes.tileCard} h="100%" withBorder>
          <Stack spacing={8} py="md">
            <Title order={3} px="md">
              Top Earning Resources
            </Title>
            <ClearableTextInput
              px="md"
              placeholder="Search your resources"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
            {isLoading ? (
              <Center px="md">
                <Loader />
              </Center>
            ) : filteredResources.length > 0 ? (
              <ScrollArea.Autosize maxHeight={400}>
                <Stack spacing={8} px="md">
                  {filteredResources.map((version) => {
                    const isSelected = filteredVersionIds.includes(version.id);

                    return (
                      <UnstyledButton
                        key={version.id}
                        p={4}
                        sx={(theme) => ({
                          borderRadius: theme.radius.sm,
                          backgroundColor: isSelected
                            ? theme.fn.rgba(theme.colors.yellow[7], 0.1)
                            : undefined,
                        })}
                        onClick={() => {
                          setFilteredVersionIds((ids) =>
                            isSelected
                              ? ids.filter((id) => id !== version.id)
                              : [...ids, version.id]
                          );
                          setSearch('');
                        }}
                      >
                        <Group position="apart" spacing={8} noWrap>
                          <Stack spacing={0}>
                            <Text size="sm" weight="bold" lineClamp={1}>
                              {version.modelName}
                            </Text>
                            <Text size="xs" color="dimmed" lineClamp={1}>
                              {version.name}
                            </Text>
                          </Stack>
                          <Group spacing={4} noWrap>
                            <CurrencyIcon currency={Currency.BUZZ} size={16} />
                            <Text
                              size="sm"
                              color="yellow.7"
                              weight="bold"
                              style={{ fontVariant: 'tabular-nums' }}
                            >
                              {formatCurrencyForDisplay(version.totalSum, Currency.BUZZ)}
                            </Text>
                          </Group>
                        </Group>
                      </UnstyledButton>
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
            ) : (
              <Center px="md">
                <NoData
                  message={
                    debouncedSearch && !filteredResources.length
                      ? 'No resources found. Try changing your search terms'
                      : undefined
                  }
                />
              </Center>
            )}
          </Stack>
        </Paper>
      </Grid.Col>
    </Grid>
  );
}

function NoData({ message }: { message?: string }) {
  return (
    <Center>
      <Text color="dimmed">
        {message ??
          'Whoops! Looks like we are still collecting data on your models for this month. Come back later'}
      </Text>
    </Center>
  );
}
