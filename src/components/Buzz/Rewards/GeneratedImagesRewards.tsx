import { Center, Loader, MultiSelect, Paper, Stack, Text, Title } from '@mantine/core';
import {
  CategoryScale,
  Chart as ChartJS,
  ChartOptions,
  Tooltip as ChartTooltip,
  Colors,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
} from 'chart.js';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { useBuzzDashboardStyles } from '~/components/Buzz/buzz.styles';
import { maxDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ChartTooltip,
  Colors,
  Legend
);

const DEFAULT_TIMEFRAME = 30;

export const GeneratedImagesReward = () => {
  const [filteredVersionIds, setFilteredVersionIds] = useState<number[]>([]);
  const { data: modelVersions = [], isLoading } =
    trpc.modelVersion.modelVersionsGeneratedImagesOnTimeframe.useQuery({
      timeframe: DEFAULT_TIMEFRAME,
    });

  const { classes, theme } = useBuzzDashboardStyles();
  const labelColor = theme.colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      aspectRatio: 3,
      responsive: true,
      scales: {
        y: {
          title: {
            display: true,
            text: 'Images generated',
            color: labelColor,
          },
          suggestedMin: 0,
          ticks: {
            stepSize: 1000,
            color: labelColor,
          },
        },
        x: {
          ticks: {
            color: labelColor,
          },
        },
      },
      plugins: {
        legend: {
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
  }, [modelVersions, filteredVersionIds]);

  const multiselectItems = useMemo(() => {
    return modelVersions.map((version) => ({
      label: `${version.modelName} - ${version.modelVersionName}`,
      value: version.id.toString(),
    }));
  }, [modelVersions]);

  if (modelVersions.length === 0) {
    return null;
  }

  return (
    <Paper withBorder className={classes.tileCard} h="100%">
      <Stack p="md">
        <Title order={3}>Images generated with your models</Title>
        <Stack spacing={0}>
          <Text>
            This chart shows the number of images generated with your resources over the past 30
            days.
          </Text>
          <Text>
            You can use this information to gain insight into the popularity of your models and
            their usage
          </Text>
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
              label="Filter models. "
              description="By default, we only show you your 10 most performant models. Only models with generated images are shown."
              limit={50}
            />
            <Line
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
              Whoops! Looks like we are still collecting data on your models for this month. Come
              back later
            </Text>
          </Center>
        )}
      </Stack>
    </Paper>
  );
};
