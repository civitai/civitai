import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
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
import { IconInfoCircle } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { useComputedColorScheme, useMantineTheme } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { trpc } from '~/utils/trpc';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler);

type TimePoint = { bucket: string; value: number };

type AnalyticsData = {
  range: { from: string | Date; to: string | Date; granularity: 'day' | 'week' };
  notOwned: boolean;
  installs: { total: number; active: number; series: TimePoint[] };
  runs: { count: number; buzzSpent: number; series: TimePoint[] };
  buzzPurchased: { count: number; buzzAmount: number; grossCents: number };
  engagement: {
    apiCalls: number;
    activeUsers: number;
    errorRate: number;
    topScopes: Array<{ scope: string; count: number }>;
    topEndpoints: Array<{ endpoint: string; count: number }>;
  };
};

type MyApp = {
  id: string;
  appName: string | null;
  blockId: string;
};

function MetricCard({
  label,
  value,
  sub,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  tooltip?: string;
}) {
  return (
    <Card padding="md" radius="md" withBorder>
      <Group gap="xs">
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          {label}
        </Text>
        {tooltip && (
          <Tooltip label={tooltip} position="top" multiline maw={280}>
            <IconInfoCircle size={14} />
          </Tooltip>
        )}
      </Group>
      <Title order={3} mt={4}>
        {value}
      </Title>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </Card>
  );
}

function MiniLineChart({
  points,
  granularity,
}: {
  points: TimePoint[];
  granularity: 'day' | 'week';
}) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const lineColor = theme.colors.blue[colorScheme === 'dark' ? 5 : 6];

  const data = useMemo(
    () => ({
      labels: points.map((p) => p.bucket),
      datasets: [
        {
          data: points.map((p) => p.value),
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
            title: (items) =>
              dayjs.utc(items[0]?.label).format(granularity === 'week' ? 'MMM D' : 'MMM D'),
            label: (item) => `${item.parsed.y}`,
          },
        },
      },
    }),
    [granularity]
  );

  if (!points.length) {
    return (
      <Text c="dimmed" size="xs" py="sm">
        No data in this range.
      </Text>
    );
  }

  return (
    <div className="h-16 w-full">
      <Line data={data} options={options} />
    </div>
  );
}

/**
 * @param scopedAppBlockId When supplied, the panel is locked to a single app
 *   (the per-app picker is hidden) — used when the panel is opened in a modal
 *   from a specific app's row on /apps/my-submissions. When omitted the panel
 *   shows the "All my apps" picker (the /apps/revenue dashboard usage).
 */
export function AppAnalyticsPanel({ scopedAppBlockId }: { scopedAppBlockId?: string } = {}) {
  const scoped = scopedAppBlockId != null;
  const { data: appsRaw, isLoading: appsLoading } = trpc.blocks.getMyApps.useQuery(undefined, {
    // No need to load the picker list when we're locked to one app.
    enabled: !scoped,
  });
  const apps = (appsRaw as MyApp[] | undefined) ?? [];
  const [pickedAppBlockId, setPickedAppBlockId] = useState<string | null>(null);
  const appBlockId = scoped ? scopedAppBlockId : pickedAppBlockId;

  const {
    data: analyticsRaw,
    isLoading: analyticsLoading,
    error,
  } = trpc.blocks.getMyAppAnalytics.useQuery({
    appBlockId: appBlockId ?? undefined,
  });
  const analytics = analyticsRaw as AnalyticsData | undefined;

  const appOptions = [
    { value: '', label: 'All my apps' },
    ...apps.map((a) => ({
      value: a.id,
      label: a.appName ?? a.blockId ?? a.id,
    })),
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        {!scoped && (
          <Select
            label="App"
            data={appOptions}
            value={pickedAppBlockId ?? ''}
            onChange={(v) => setPickedAppBlockId(v ? v : null)}
            disabled={appsLoading}
            w={260}
            comboboxProps={{ withinPortal: true }}
          />
        )}
        {analytics && (
          <Text size="xs" c="dimmed">
            {dayjs(analytics.range.from).format('MMM D, YYYY')} –{' '}
            {dayjs(analytics.range.to).format('MMM D, YYYY')} ({analytics.range.granularity})
          </Text>
        )}
      </Group>

      {analyticsLoading && (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      )}
      {error && (
        <Text c="red" size="sm">
          Failed to load analytics: {error.message}
        </Text>
      )}

      {analytics && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
            <MetricCard
              label="Active installs"
              value={analytics.installs.active.toLocaleString()}
              sub={`${analytics.installs.total.toLocaleString()} total (all time)`}
              tooltip="Currently-enabled installs. Total counts every install ever created."
            />
            <MetricCard
              label="Runs (range)"
              value={analytics.runs.count.toLocaleString()}
              sub={`${analytics.runs.buzzSpent.toLocaleString()} Buzz spent`}
              tooltip="Generations run through your app within the selected range, and the viewer Buzz burned doing so."
            />
            <MetricCard
              label="Buzz purchased"
              value={analytics.buzzPurchased.buzzAmount.toLocaleString()}
              sub={`${analytics.buzzPurchased.count.toLocaleString()} purchase${
                analytics.buzzPurchased.count === 1 ? '' : 's'
              } · $${(analytics.buzzPurchased.grossCents / 100).toFixed(2)}`}
              tooltip="Buzz bought via card from inside your app within the range (gross value shown)."
            />
            <MetricCard
              label="Active users"
              value={analytics.engagement.activeUsers.toLocaleString()}
              sub={`${analytics.engagement.apiCalls.toLocaleString()} API calls`}
              tooltip="Distinct signed-in users who made a scoped API call within the range. See the coverage note below."
            />
          </SimpleGrid>

          <Alert
            variant="light"
            color="gray"
            icon={<IconInfoCircle size={16} />}
            title="What engagement counts"
          >
            <Text size="sm">
              Active users, API calls, and error rate reflect only{' '}
              <strong>authenticated, scope-gated API calls</strong> your app makes. A static block
              (or one with no scoped API surface) will show installs and revenue but flat
              engagement, and <strong>anonymous viewers are not counted</strong>. Installs, runs,
              and Buzz figures are unaffected.
            </Text>
          </Alert>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Card padding="md" radius="md" withBorder>
              <Title order={5}>New installs over time</Title>
              <MiniLineChart
                points={analytics.installs.series}
                granularity={analytics.range.granularity}
              />
            </Card>
            <Card padding="md" radius="md" withBorder>
              <Title order={5}>Runs over time</Title>
              <MiniLineChart
                points={analytics.runs.series}
                granularity={analytics.range.granularity}
              />
            </Card>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Card padding="md" radius="md" withBorder>
              <Group justify="space-between">
                <Title order={5}>Top scopes</Title>
                <Badge variant="light" color="gray" size="sm">
                  {(analytics.engagement.errorRate * 100).toFixed(1)}% errors
                </Badge>
              </Group>
              {analytics.engagement.topScopes.length === 0 ? (
                <Text c="dimmed" size="sm" mt="sm">
                  No scoped API calls in this range.
                </Text>
              ) : (
                <Table mt="sm">
                  <Table.Tbody>
                    {analytics.engagement.topScopes.map((s) => (
                      <Table.Tr key={s.scope}>
                        <Table.Td>{s.scope}</Table.Td>
                        <Table.Td ta="right">{s.count.toLocaleString()}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Card>
            <Card padding="md" radius="md" withBorder>
              <Title order={5}>Top endpoints</Title>
              {analytics.engagement.topEndpoints.length === 0 ? (
                <Text c="dimmed" size="sm" mt="sm">
                  No scoped API calls in this range.
                </Text>
              ) : (
                <Table mt="sm">
                  <Table.Tbody>
                    {analytics.engagement.topEndpoints.map((e) => (
                      <Table.Tr key={e.endpoint}>
                        <Table.Td>
                          <Text size="sm" lineClamp={1}>
                            {e.endpoint}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">{e.count.toLocaleString()}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Card>
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
