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
    value: date.startOf('month').toISOString(),
    label: date.format('MMMM YYYY'),
  };
});

export const DailyBuzzPayout = () => {
  const [filteredVersionIds, setFilteredVersionIds] = useState<number[]>([]);
  const [selectedDate, setSelectedDate] = useState(dateOptions[0].value);
  const { userStripeConnect } = useUserStripeConnect();
  const { data: modelVersions = [], isLoading } =
    trpc.modelVersion.modelVersionsGeneratedImagesOnTimeframe.useQuery(
      { timeframe: dayjs().diff(dayjs(selectedDate).startOf('month'), 'day') },
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
    const today = dayjs().startOf('day');
    let day = dayjs(
      maxDate(today.subtract(DEFAULT_TIMEFRAME, 'day').toDate(), today.startOf('month').toDate())
    );
    while (day.isBefore(today)) {
      data.push(day.format('YYYY-MM-DD'));
      day = day.add(1, 'day');
    }

    return data;
  }, []);

  const datasets = useMemo(() => {
    const data =
      filteredVersionIds.length > 0
        ? modelVersions.filter((v) => filteredVersionIds.includes(v.id))
        : modelVersions.slice(0, 10);

    return data.map((modelVersion) => {
      return {
        label: `${modelVersion.modelName} - ${modelVersion.modelVersionName}`,
        data: (modelVersion.data ?? [])
          .filter((data) => labels.includes(data.createdAt))
          .map((data) => ({
            x: data.createdAt,
            y: data.generations,
          })),
      };
    });
  }, [filteredVersionIds, modelVersions, labels]);

  const multiselectItems = useMemo(() => {
    return modelVersions.map((version) => ({
      label: `${version.modelName} - ${version.modelVersionName}`,
      value: version.id.toString(),
    }));
  }, [modelVersions]);

  if (userStripeConnect?.status !== StripeConnectStatus.Approved) {
    return null;
  }

  const totalBuzz = modelVersions.reduce((acc, version) => acc + version.generations, 0);

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
            {!isLoading && modelVersions.length > 0 ? (
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
              <Center>
                <Text color="dimmed">
                  Whoops! Looks like we are still collecting data on your models for this month.
                  Come back later
                </Text>
              </Center>
            )}
          </Stack>
        </Paper>
      </Grid.Col>
      <Grid.Col xs={12} md={4}>
        <Paper withBorder className={classes.tileCard} h="100%" p="md">
          <Title order={3} mb="xs">
            Top Earning Resources
          </Title>
          <ScrollArea style={{ height: 400 }}>
            <Stack>
              {modelVersions.map((version) => (
                <Group key={version.id} position="apart" spacing={8} noWrap>
                  <Stack spacing={0}>
                    <Text size="sm" weight="bold" lineClamp={1}>
                      {version.modelName}
                    </Text>
                    <Text size="xs" color="dimmed" lineClamp={1}>
                      {version.modelVersionName}
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
                      {formatCurrencyForDisplay(version.generations, Currency.BUZZ)}
                    </Text>
                  </Group>
                </Group>
              ))}
            </Stack>
          </ScrollArea>
        </Paper>
      </Grid.Col>
    </Grid>
  );
};
