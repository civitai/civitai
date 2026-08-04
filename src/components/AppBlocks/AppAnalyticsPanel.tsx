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
import {
  endpointBucketLabel,
  scopeBucketLabel,
} from '~/components/AppBlocks/analytics-bucket-labels';
import { trpc } from '~/utils/trpc';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler);

type TimePoint = { bucket: string; value: number };

type AnalyticsData = {
  range: { from: string | Date; to: string | Date; granularity: 'day' | 'week' };
  notOwned: boolean;
  unavailable?: 'notEntitled' | 'notOwned';
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
  /**
   * Impressions (`blockRenders`). `unavailable` is a PER-SECTION flag, unlike
   * the payload-level one above: this is the only section read from ClickHouse,
   * which can be slow or down while every Postgres-derived number here is
   * measured. When it is set the counters are placeholders — render an em dash,
   * not a 0.
   *
   * OPTIONAL on purpose. tRPC output is not zod-validated on the client, so a
   * rolling deploy can hand a new bundle a payload from an old pod that has no
   * `views` key. That is a third state — absent — and it must render like
   * `unavailable`, never like a measured zero.
   */
  views?: {
    count: number;
    uniqueViewers: number;
    anonCount: number;
    unavailable?: boolean;
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
  const unavailable = analytics?.unavailable;

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
        {analytics && !unavailable && (
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

      {unavailable && (
        <Alert
          variant="light"
          color="yellow"
          icon={<IconInfoCircle size={16} />}
          title="Analytics unavailable"
        >
          <Text size="sm">
            {unavailable === 'notEntitled'
              ? 'Your account does not have access to app analytics yet. No metrics were measured for this app — this is not a report of zero activity.'
              : 'You do not own this app, so its analytics are not available to you. No metrics were measured — this is not a report of zero activity.'}
          </Text>
        </Alert>
      )}

      {analytics && !unavailable && (
        <>
          {/*
            `type="container"` is load-bearing, not tidiness. This panel renders
            BOTH full-width (/apps/revenue) and inside AppAnalyticsInline's
            `Modal size="xl"` (48.75rem ≈ 780px). Mantine's default `media`
            breakpoints resolve against the VIEWPORT, so on any ≥1200px screen
            the modal would take the 5-column branch inside 780px — ~135px per
            card, ~103px usable after Card padding, for a heading number plus a
            two-clause sub-line. Container queries resolve against the panel's
            own width, so the embedded copy steps down instead of squeezing.

            🔴 The keys MUST be explicit lengths, not `sm`/`md`/`lg`. Mantine's
            container branch interpolates the key VERBATIM into the query
            (`SimpleGridVariables.mjs`: `simple-grid (min-width: ${key})`),
            unlike the media branch, which resolves `theme.breakpoints[key]`.
            Named keys therefore emit `(min-width: sm)` — not a valid <length>,
            so the query NEVER matches and every width silently falls back to
            `base`, i.e. one column everywhere. Measured: with named keys the
            full-width page rendered 1 column at 1400px; with lengths, 5. These
            values are Mantine's own sm/md/lg (48em/62em/75em), which this app
            does not override. `ContainerGrid2` passes explicit breakpoints for
            the same reason.
          */}
          <SimpleGrid
            type="container"
            cols={{ base: 1, '48em': 2, '62em': 3, '75em': 5 }}
            spacing="md"
          >
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
            {/*
              Impressions come from ClickHouse, which can be unconfigured, slow
              or down while every other card here is fine. Rendering a plain "0"
              in that case is the fabricated-zero defect (#3557/#3581): the
              author cannot tell "nobody looked" from "we never asked". So an
              unavailable read renders an em dash, never a number.

              🔴 `analytics.views` is read through `?.` because tRPC output is
              NOT zod-validated on the client: during a rolling deploy a new
              bundle can hit an old pod whose payload has no `views` key at all,
              and an unguarded read throws in render. An absent section is an
              UNKNOWN, so it takes the same branch as an outage — never the
              zero branch.
            */}
            <MetricCard
              label="App loads (range)"
              value={
                !analytics.views || analytics.views.unavailable
                  ? '—'
                  : analytics.views.count.toLocaleString()
              }
              sub={
                !analytics.views || analytics.views.unavailable
                  ? 'Not measured right now'
                  : `${analytics.views.uniqueViewers.toLocaleString()} unique viewer${
                      analytics.views.uniqueViewers === 1 ? '' : 's'
                    }${
                      analytics.views.anonCount > 0
                        ? ` · ${analytics.views.anonCount.toLocaleString()} signed-out load${
                            analytics.views.anonCount === 1 ? '' : 's'
                          }`
                        : ''
                    }`
              }
              tooltip={
                !analytics.views || analytics.views.unavailable
                  ? 'The impression store could not be read, so this is NOT a report of zero loads. The other metrics on this page are unaffected.'
                  : 'Times your app was loaded within the range, including by signed-out visitors. A load that FAILED still counts — this measures attempts to open your app, not successful sessions. Unique viewers counts signed-in people once each and approximates signed-out ones by network address, so it is a reach indicator rather than an identity count.'
              }
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
              engagement. <strong>Views</strong> is the exception — it is measured on every load, so
              it counts signed-out visitors and static blocks that the engagement figures cannot
              see. Installs, runs, and Buzz figures are unaffected.
            </Text>
          </Alert>

          <SimpleGrid type="container" cols={{ base: 1, '62em': 2 }} spacing="md">
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

          <SimpleGrid type="container" cols={{ base: 1, '62em': 2 }} spacing="md">
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
                    {/* key stays the RAW scope — labels can collide, keys cannot. */}
                    {analytics.engagement.topScopes.map((s) => (
                      <Table.Tr key={s.scope}>
                        <Table.Td>
                          <Text size="sm" lineClamp={1}>
                            {scopeBucketLabel(s.scope)}
                          </Text>
                        </Table.Td>
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
                            {endpointBucketLabel(e.endpoint)}
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
