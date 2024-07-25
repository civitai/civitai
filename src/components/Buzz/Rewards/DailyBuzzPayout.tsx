import {
  Center,
  Grid,
  Group,
  Loader,
  MultiSelect,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
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
} from 'chart.js';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import { useBuzzDashboardStyles } from '~/components/Buzz/buzz.styles';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useUserStripeConnect } from '~/components/Stripe/stripe.utils';
import { getDatesAsList, maxDate } from '~/utils/date-helpers';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  BarElement,
  ChartTooltip,
  Colors,
  Legend
);

const DEFAULT_TIMEFRAME = 30;
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

export const DailyBuzzPayout = () => {
  const [filteredVersionIds, setFilteredVersionIds] = useState<number[]>([]);
  const [selectedDate, setSelectedDate] = useState(dateOptions[0].value);
  const { userStripeConnect } = useUserStripeConnect();
  const { data: resources = [], isLoading } = trpc.buzz.getDailyBuzzCompensation.useQuery(
    { date: selectedDate },
    { enabled: userStripeConnect?.status === StripeConnectStatus.Approved }
  );

  const { classes, theme } = useBuzzDashboardStyles();
  const labelColor = theme.colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];

  const options = useMemo<ChartOptions<'bar'>>(
    () => ({
      aspectRatio: 3,
      responsive: true,
      scales: {
        y: {
          title: {
            display: true,
            text: '⚡️ Buzz earned',
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
          ticks: {
            color: labelColor,
          },
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
        title: {
          display: false,
        },
        tooltip: {
          callbacks: {
            title(tooltipItems) {
              const sum = tooltipItems.reduce((acc, item) => acc + item.parsed.y, 0);
              return `Total: ⚡️ ${formatCurrencyForDisplay(sum, 'BUZZ')}`;
            },
          },
        },
      },
    }),
    [labelColor]
  );

  const labels = useMemo(() => {
    const data = [];
    const today = dayjs(selectedDate).startOf('day');
    let day = dayjs(
      maxDate(today.subtract(DEFAULT_TIMEFRAME, 'day').toDate(), today.startOf('month').toDate())
    );
    while (day.isBefore(today)) {
      data.push(day.format('YYYY-MM-DD'));
      day = day.add(1, 'day');
    }

    return data;
  }, [selectedDate]);

  const datasets = useMemo(() => {
    const data =
      filteredVersionIds.length > 0
        ? resources.filter((v) => filteredVersionIds.includes(v.id))
        : resources.slice(0, 10);

    return data.map((resource) => {
      return {
        label: `${resource.modelName} - ${resource.name}`,
        data: (resource.data ?? [])
          .filter((data) => labels.includes(data.createdAt))
          .map((data) => ({
            x: data.createdAt,
            y: data.total,
          })),
      };
    });
  }, [filteredVersionIds, resources, labels]);

  const multiselectItems = useMemo(() => {
    return resources.map((resource) => ({
      label: `${resource.modelName} - ${resource.name}`,
      value: resource.id.toString(),
    }));
  }, [resources]);

  if (userStripeConnect?.status !== StripeConnectStatus.Approved) {
    return null;
  }

  const totalBuzz = resources.reduce((acc, resource) => acc + resource.dailyTotal, 0);

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
              <Stack>
                <MultiSelect
                  data={multiselectItems}
                  value={filteredVersionIds.map((id) => id.toString())}
                  onChange={(data) => setFilteredVersionIds(data.map((x) => Number(x)))}
                  searchable
                  placeholder="Search models"
                  nothingFound="No models found..."
                  label="Filter models"
                  description="By default, we only show you your 10 most performant models"
                  limit={50}
                />
                <Bar
                  key={filteredVersionIds.join('-')}
                  options={options}
                  data={{
                    labels,
                    datasets,
                  }}
                />
              </Stack>
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
        <Paper withBorder className={classes.tileCard} h="100%" p="md">
          <Title order={3} mb="xs">
            Top Earning Resources
          </Title>
          {isLoading ? (
            <Center>
              <Loader />
            </Center>
          ) : resources.length > 0 ? (
            <ScrollArea.Autosize maxHeight={400}>
              <Stack>
                {resources.map((version) => (
                  <Group key={version.id} position="apart" spacing={8} noWrap>
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
                        {formatCurrencyForDisplay(version.dailyTotal, Currency.BUZZ)}
                      </Text>
                    </Group>
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          ) : (
            <NoData />
          )}
        </Paper>
      </Grid.Col>
    </Grid>
  );
};

function NoData() {
  return (
    <Center>
      <Text color="dimmed">
        Whoops! Looks like we are still collecting data on your models for this month. Come back
        later
      </Text>
    </Center>
  );
}
