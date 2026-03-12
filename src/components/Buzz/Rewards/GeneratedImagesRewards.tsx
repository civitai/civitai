import {
  Center,
  Divider,
  Group,
  Loader,
  MultiSelect,
  Paper,
  Popover,
  Stack,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ChartOptions } from 'chart.js';
import {
  CategoryScale,
  Chart as ChartJS,
  Tooltip as ChartTooltip,
  Colors,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
} from 'chart.js';
import dayjs from '~/shared/utils/dayjs';
import { useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import classes from '~/components/Buzz/buzz.module.scss';
import { abbreviateValue, truncateLabel, chartTooltipDefaults } from '~/components/Buzz/chart-defaults';
import { useIsMobile } from '~/hooks/useIsMobile';
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
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const labelColor = colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];
  const mobile = useIsMobile({ breakpoint: 'sm' });

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      aspectRatio: mobile ? 1.4 : 3,
      responsive: true,
      scales: {
        y: {
          beginAtZero: false,
          suggestedMin: 1,
          ticks: {
            color: labelColor,
            callback: abbreviateValue,
          },
          grid: { color: 'rgba(128, 128, 128, 0.1)' },
        },
        x: {
          type: 'time' as const,
          ticks: {
            color: labelColor,
            maxTicksLimit: mobile ? 5 : 8,
            autoSkip: true,
          },
          grid: { display: false },
        },
      },
      plugins: {
        legend: {
          display: !mobile,
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            borderRadius: 5,
            useBorderRadius: true,
            color: labelColor,
            generateLabels: (chart) => {
              const original = ChartJS.defaults.plugins.legend.labels.generateLabels?.(chart) ?? [];
              return original.map((label) => ({
                ...label,
                text: truncateLabel(label.text ?? '', 40),
              }));
            },
          },
        },
        title: { display: false },
        tooltip: chartTooltipDefaults({
          formatValue: (val) => val.toLocaleString(),
        }),
      },
    }),
    [labelColor, mobile]
  );

  const labels = useMemo(() => {
    const data = [];
    const today = dayjs().startOf('day');
    let day = today.subtract(DEFAULT_TIMEFRAME, 'day');
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
    <Paper className={classes.tileCard} h="100%" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <Stack gap={2} p="md" pb="sm">
        <Group gap={6} align="center">
          <h3 className="text-xl font-bold">Model Generation Activity</h3>
          <Popover width={320} withArrow withinPortal shadow="sm">
            <Popover.Target>
              <IconInfoCircle size={18} style={{ cursor: 'pointer', color: 'var(--mantine-color-dimmed)' }} />
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <Text size="sm">
                  This chart shows the number of images generated with your published resources over the past 30 days.
                </Text>
                <Text size="sm" c="dimmed">
                  Use this to gain insight into the popularity of your models and their usage trends.
                </Text>
              </Stack>
            </Popover.Dropdown>
          </Popover>
        </Group>
        <Text size="sm" c="dimmed">
          Generation trends for your top models over the last 30 days
        </Text>
      </Stack>

      {/* Filter section */}
      {!isLoading && modelVersions.length > 0 && (
        <>
          <Divider />
          <Stack gap={4} className="px-[var(--mantine-spacing-md)] py-[var(--mantine-spacing-sm)]">
            <Group justify="space-between" align="center">
              <Text size="sm" fw={500}>Filter models</Text>
              <Text size="xs" c="dimmed">Showing your 10 most popular by default</Text>
            </Group>
            <MultiSelect
              data={multiselectItems}
              value={filteredVersionIds.map((id) => id.toString())}
              onChange={(data) => setFilteredVersionIds(data.map((x) => Number(x)))}
              searchable
              placeholder="Search models"
              nothingFoundMessage="No models found..."
              limit={50}
              size="sm"
            />
          </Stack>
          <Divider />
        </>
      )}

      {/* Chart / Loading / Empty */}
      {!isLoading && modelVersions.length > 0 ? (
        <div style={{ padding: 'var(--mantine-spacing-md)' }}>
          <Line
            key={filteredVersionIds.join('-')}
            options={options}
            data={{
              labels,
              datasets,
            }}
          />
        </div>
      ) : isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : (
        <Center py="xl">
          <Text c="dimmed" size="sm">
            No generation data available yet — check back soon
          </Text>
        </Center>
      )}
    </Paper>
  );
};
