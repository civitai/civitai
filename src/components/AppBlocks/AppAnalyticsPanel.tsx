import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
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
import { useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { useComputedColorScheme, useMantineTheme } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { AppsTableColgroup, APPS_CUSTOM_EVENTS_COLUMNS } from '~/components/Apps/appsWideLayout';
import {
  endpointBucketLabel,
  scopeBucketLabel,
} from '~/components/AppBlocks/analytics-bucket-labels';
import { trpc } from '~/utils/trpc';
import type { CustomEventPropertyBreakdown } from '~/server/services/blocks/app-custom-events.service';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler);

type TimePoint = { bucket: string; value: number };

type AnalyticsData = {
  range: { from: string | Date; to: string | Date; granularity: 'day' | 'week' };
  notOwned: boolean;
  unavailable?: 'notEntitled' | 'notOwned';
  /**
   * Installs (`block_user_subscriptions`). `notApplicable` is a PER-SECTION
   * flag: a page app is STATELESS by decision, so an install row cannot exist
   * for it and the zeros are a category error, not "nobody installed me".
   *
   * DISTINCT from `views.unavailable` — that one means "we could not ask", this
   * one means "we asked and the question is meaningless here". Both render an
   * em dash rather than a number, but for different reasons, so they get
   * different copy.
   *
   * 🔴 A measured zero (a model-slot app with no installs YET) arrives with the
   * flag ABSENT and MUST still render `0` — hiding it behind "n/a" would be a
   * new fabricated-zero bug pointing the other way. The server is what makes
   * that distinction (it never sets the flag when a counter is non-zero, and
   * never sets it for an installable app); this renderer must not second-guess
   * it by inferring anything from the number itself.
   *
   * `installs` itself is REQUIRED (unlike `views`), so it is read directly — do
   * not "restore" optional chaining on it. Only `notApplicable` is optional,
   * for the same reason `views` is: tRPC output is not zod-validated on the
   * client, so a rolling deploy can hand this bundle an older pod's payload
   * with no `notApplicable` key. Absent → falsy → the measured branch, which is
   * exactly today's behaviour and therefore safe.
   */
  installs: { total: number; active: number; series: TimePoint[]; notApplicable?: boolean };
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

const MANIFEST_DOCS_URL = 'https://developer.civitai.com/apps/reference/manifest';

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

function formatStat(n: number | null): string {
  return n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function propertyTotal(property: CustomEventPropertyBreakdown): number {
  if (property.type === 'enum') return property.values.reduce((sum, v) => sum + v.count, 0);
  if (property.type === 'number') return property.count;
  return property.trueCount + property.falseCount;
}

function PropertyBreakdown({ property }: { property: CustomEventPropertyBreakdown }) {
  const total = propertyTotal(property);
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Text size="sm" fw={600}>
          {property.name}
        </Text>
        <Badge variant="light" color="gray" size="xs">
          {property.type}
        </Badge>
      </Group>
      {total === 0 ? (
        <Text size="sm" c="dimmed">
          Not set on any event in this range.
        </Text>
      ) : property.type === 'enum' ? (
        <Table>
          <Table.Tbody>
            {property.values.map((v) => (
              <Table.Tr key={v.value}>
                <Table.Td>
                  <Text size="sm" lineClamp={1} title={v.value}>
                    {v.value}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">{v.count.toLocaleString()}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : property.type === 'number' ? (
        <Text size="sm">
          {`Set on ${property.count.toLocaleString()} event${
            property.count === 1 ? '' : 's'
          } · sum ${formatStat(property.sum)} · avg ${formatStat(
            property.avg
          )} · median ${formatStat(property.p50)} · p95 ${formatStat(property.p95)}`}
        </Text>
      ) : (
        <Text size="sm">
          {`true ${property.trueCount.toLocaleString()} · false ${property.falseCount.toLocaleString()}`}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Reads `blocks.getMyAppCustomEvents`, its own procedure, so the toggle and event selection
 * re-run only these ClickHouse reads. 🔴 An unavailable section, or a failed request (including
 * an old pod without the procedure), must never render a count: "0 events" there is a
 * fabricated zero.
 */
function CustomEventsCard({ appBlockId }: { appBlockId: string | null }) {
  const [includeOwner, setIncludeOwner] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const {
    data: customEvents,
    isLoading,
    isPlaceholderData,
    error,
  } = trpc.blocks.getMyAppCustomEvents.useQuery(
    {
      appBlockId: appBlockId ?? '',
      includeOwner,
      ...(selectedEvent ? { event: selectedEvent } : {}),
    },
    { enabled: appBlockId != null, placeholderData: keepPreviousData }
  );
  const appSelected = appBlockId != null;
  const refreshing = !!isPlaceholderData;
  const granularity = customEvents?.range.granularity ?? 'day';
  const detailRef = useRef<HTMLDivElement>(null);
  const measured = !error && customEvents && !customEvents.unavailable ? customEvents : undefined;
  // During a refetch the previous payload is shown, and its selection may be another event's.
  const selected =
    measured?.selected && measured.selected.eventName === selectedEvent
      ? measured.selected
      : undefined;
  const nothingRecorded = measured ? measured.topEvents.every((e) => e.count === 0) : false;

  const selectEvent = (eventName: string | null) => {
    setSelectedEvent(eventName);
    // In one column (the modal) the detail sits below the whole table, often off-screen.
    const detail = detailRef.current;
    if (eventName && detail && detail.getBoundingClientRect().top > window.innerHeight - 80) {
      detail.scrollIntoView?.({ block: 'start' });
    }
  };

  return (
    <Card padding="md" radius="md" withBorder>
      <Group justify="space-between" align="flex-start" gap="xs">
        <Group gap="xs">
          <Title order={5}>Custom events</Title>
          <Tooltip
            label="Events your app sends with useBlockAnalytics().track(), for the event names and properties its approved manifest declares."
            position="top"
            multiline
            maw={280}
          >
            <IconInfoCircle size={14} />
          </Tooltip>
          {refreshing && <Loader size="xs" role="status" aria-label="Refreshing custom events" />}
        </Group>
        {appSelected && (
          <Switch
            size="sm"
            label="Include team activity"
            description="Events sent while the app owner or an accepted collaborator was signed in."
            checked={includeOwner}
            onChange={(e) => setIncludeOwner(e.currentTarget.checked)}
            maw={340}
          />
        )}
      </Group>

      {!appSelected ? (
        <Text c="dimmed" size="sm" mt="sm">
          Choose an app to see its custom events.
        </Text>
      ) : isLoading ? (
        <Group justify="center" py="sm">
          <Loader size="sm" role="status" aria-label="Loading custom events" />
        </Group>
      ) : !measured ? (
        <Stack gap="xs" mt="sm" align="flex-start">
          <Text c="dimmed" size="sm">
            Couldn&apos;t load custom events right now. This is not a report of zero events; the
            other metrics on this page are unaffected.
          </Text>
          {selectedEvent && (
            <Button variant="subtle" size="compact-sm" onClick={() => setSelectedEvent(null)}>
              Clear the selected event
            </Button>
          )}
        </Stack>
      ) : (
        <Stack
          gap="sm"
          mt="sm"
          aria-busy={refreshing}
          style={refreshing ? { opacity: 0.6 } : undefined}
        >
          {measured.undeclaredDrops > 0 && (
            <Alert variant="light" color="yellow" icon={<IconInfoCircle size={16} />}>
              <Text size="sm">
                {measured.undeclaredDrops.toLocaleString()}{' '}
                {measured.undeclaredDrops === 1
                  ? 'event was sent in this range with a name'
                  : 'events were sent in this range with names'}{' '}
                your approved manifest doesn&apos;t declare, so{' '}
                {measured.undeclaredDrops === 1 ? 'it was' : 'they were'} not recorded by name.
                Declare an event in your manifest and resubmit to see it here.
              </Text>
            </Alert>
          )}

          {measured.declared.length === 0 ? (
            <Text size="sm">
              This app doesn&apos;t declare any custom events.{' '}
              <Anchor href={MANIFEST_DOCS_URL} target="_blank" rel="noopener noreferrer">
                Declare events in your manifest
              </Anchor>{' '}
              to see what people do inside your app.
            </Text>
          ) : (
            <>
              <SimpleGrid type="container" cols={{ base: 1, '62em': 2 }} spacing="md">
                <div>
                  {nothingRecorded && (
                    <Text c="dimmed" size="sm">
                      No declared events were recorded in this range.
                    </Text>
                  )}
                  <Table.ScrollContainer minWidth={420}>
                    <Table>
                      <AppsTableColgroup columns={APPS_CUSTOM_EVENTS_COLUMNS} />
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Event</Table.Th>
                          <Table.Th ta="right">Events</Table.Th>
                          <Table.Th ta="right">Signed-in viewers</Table.Th>
                          <Table.Th ta="right">Signed-out events</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {measured.topEvents.map((e) => {
                          const isSelected = e.eventName === selectedEvent;
                          return (
                            <Table.Tr
                              key={e.eventName}
                              bg={isSelected ? 'var(--mantine-color-blue-light)' : undefined}
                            >
                              <Table.Td>
                                <Anchor
                                  component="button"
                                  type="button"
                                  size="sm"
                                  title={e.eventName}
                                  aria-pressed={isSelected}
                                  onClick={() => selectEvent(isSelected ? null : e.eventName)}
                                >
                                  {e.eventName}
                                </Anchor>
                              </Table.Td>
                              <Table.Td ta="right">{e.count.toLocaleString()}</Table.Td>
                              <Table.Td ta="right">{e.signedInViewers.toLocaleString()}</Table.Td>
                              <Table.Td ta="right">{e.anonymousEvents.toLocaleString()}</Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </div>
                <div ref={detailRef}>
                  <VisuallyHidden aria-live="polite">
                    {selected
                      ? `Showing ${selected.eventName}`
                      : selectedEvent && !refreshing
                      ? `Details unavailable for ${selectedEvent}`
                      : ''}
                  </VisuallyHidden>
                  {selected ? (
                    <Stack gap="sm">
                      <Text size="sm" fw={600}>
                        {selected.eventName} over time
                      </Text>
                      <MiniLineChart points={selected.series} granularity={granularity} />
                      {selected.properties.length === 0 ? (
                        <Text c="dimmed" size="sm">
                          This event declares no properties.
                        </Text>
                      ) : (
                        selected.properties.map((p) => (
                          <PropertyBreakdown key={p.name} property={p} />
                        ))
                      )}
                    </Stack>
                  ) : selectedEvent ? (
                    refreshing ? (
                      <Group justify="center" py="sm">
                        <Loader size="sm" role="status" aria-label={`Loading ${selectedEvent}`} />
                      </Group>
                    ) : (
                      <Text c="dimmed" size="sm">
                        Couldn&apos;t load the details for {selectedEvent}.
                      </Text>
                    )
                  ) : (
                    <Text c="dimmed" size="sm">
                      Select an event to see it over time and its property breakdown.
                    </Text>
                  )}
                </div>
              </SimpleGrid>

              <Text c="dimmed" size="xs">
                Counts are lower bounds: apps stop sending events after a per-page limit, and those
                events are never recorded. Signed-in viewers counts each signed-in person once;
                signed-out activity is counted as events only.
              </Text>
            </>
          )}
        </Stack>
      )}
    </Card>
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
            does not override — so the rendered result matches what the named
            keys produced before container mode was introduced.

            Note this trap is specific to `SimpleGrid`. `Grid`/`ContainerGrid2`
            resolve named keys against the theme in BOTH modes
            (`GridVariables.mjs`), so the `breakpoints` prop there swaps the
            SCALE — it is not a workaround for this bug, and `SimpleGrid` has
            no such prop.
          */}
          <SimpleGrid
            type="container"
            cols={{ base: 1, '48em': 2, '62em': 3, '75em': 5 }}
            spacing="md"
          >
            {/*
              A page app CANNOT be installed — it is stateless by design, so no
              `block_user_subscriptions` row ever exists for it. Rendering "0"
              there is the same fabricated-zero defect as #3557/#3581, just with
              a different cause: the author reads "nobody installed my app" from
              a number that could never have been anything else.

              🔴 The em dash is driven ONLY by the server's `notApplicable`
              flag, never by `active === 0`. A model-slot app with no installs
              yet is a TRUTHFUL zero and must keep rendering `0` — that is the
              case that would regress silently if this branch ever grew a
              "…|| active === 0" convenience.
            */}
            <MetricCard
              label="Active installs"
              value={
                analytics.installs.notApplicable ? '—' : analytics.installs.active.toLocaleString()
              }
              sub={
                analytics.installs.notApplicable
                  ? 'Not applicable to page apps'
                  : `${analytics.installs.total.toLocaleString()} total (all time)`
              }
              tooltip={
                analytics.installs.notApplicable
                  ? 'Page apps run standalone and are not installed onto a model, so there is nothing to count here — this is NOT a report of zero installs. Your runs, Buzz and App loads figures are unaffected.'
                  : 'Currently-enabled installs. Total counts every install ever created.'
              }
            />
            <MetricCard
              label="Runs (range)"
              value={analytics.runs.count.toLocaleString()}
              sub={`${analytics.runs.buzzSpent.toLocaleString()} Buzz spent`}
              tooltip="Generations run through your app by other people within the selected range, and the viewer Buzz burned doing so. Your own test runs on your own app are not counted."
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
              The engagement figures below reflect only{' '}
              <strong>authenticated, scope-gated API calls</strong> your app makes. A static block
              (or one with no scoped API surface) will show revenue but flat engagement.{' '}
              <strong>App loads</strong> is the exception — it is measured on every load, so it
              counts signed-out visitors and static blocks that the engagement figures cannot see.
              Runs and Buzz figures are unaffected. The installs figure is blanked out for apps that
              cannot be installed at all (a page app has no install slot), which is different from a
              real zero.
            </Text>
          </Alert>

          <SimpleGrid type="container" cols={{ base: 1, '62em': 2 }} spacing="md">
            <Card padding="md" radius="md" withBorder>
              <Title order={5}>New installs over time</Title>
              {/*
                Same discriminator as the card above. An empty series would
                otherwise render MiniLineChart's "No data in this range." —
                which reads as a measurement ("nobody installed you this
                month") for an app that has no install path at all.
              */}
              {analytics.installs.notApplicable ? (
                <Text c="dimmed" size="xs" py="sm">
                  Not applicable — page apps are not installed.
                </Text>
              ) : (
                <MiniLineChart
                  points={analytics.installs.series}
                  granularity={analytics.range.granularity}
                />
              )}
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

          <SimpleGrid type="container" cols={{ base: 1 }} spacing="md">
            {/* Keyed by app so a new app starts fresh: its own toggle, no selection, and no
                previous app's numbers kept as placeholder data. */}
            <CustomEventsCard key={appBlockId ?? ''} appBlockId={appBlockId ?? null} />
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
