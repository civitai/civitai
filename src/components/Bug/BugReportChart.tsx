import { Group, Text, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import type { ChartOptions } from 'chart.js';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from 'chart.js';
import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import dayjs from '~/shared/utils/dayjs';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler);

type BugReportPoint = { date: string; users: number };

export function BugReportChart({ points }: { points: BugReportPoint[] }) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const lineColor = theme.colors.red[colorScheme === 'dark' ? 5 : 6];

  // Per-bucket distinct counts can't be summed into a true distinct total (a user may report across
  // multiple 12h windows), so we surface the current and peak bucket instead.
  const latest = points.length ? points[points.length - 1].users : 0;
  const peak = useMemo(() => points.reduce((max, p) => Math.max(max, p.users), 0), [points]);

  const data = useMemo(
    () => ({
      labels: points.map((p) => p.date),
      datasets: [
        {
          data: points.map((p) => p.users),
          borderColor: lineColor,
          backgroundColor: `${lineColor}1f`,
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: lineColor,
        },
      ],
    }),
    [points, lineColor]
  );

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true },
      },
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `${dayjs.utc(items[0]?.label).format('MMM D, HH:mm')} UTC`,
            label: (item) => `${item.parsed.y} ${item.parsed.y === 1 ? 'reporter' : 'reporters'}`,
          },
        },
      },
    }),
    []
  );

  if (!points.length) return null;

  return (
    <div className="w-full">
      <Group justify="space-between" mb={2}>
        <Text size="xs" c="dimmed">
          Reporters / 12h since first seen
        </Text>
        <Text size="xs" c="dimmed">
          {latest} now &middot; {peak} peak
        </Text>
      </Group>
      <div className="h-12 w-full">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
