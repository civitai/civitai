import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  NumberInput,
  Progress,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconDownload, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { useResourceLoadProgress } from '~/components/ResourceLoad/resource-load.utils';
import { UNLOADABLE_MESSAGES } from '~/server/schema/resource-load.schema';
import type {
  ResourceLoadAvailability,
  UnloadableReason,
} from '~/server/schema/resource-load.schema';
import { useResourceLoadStore } from '~/store/resource-load.store';
import type { TrackedResourceLoad } from '~/store/resource-load.store';
import type { ResourceLoadProgress } from '~/components/ResourceLoad/resource-load.utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const QUEUE_POLL_MS = 15_000;

const statusColors: Record<string, string> = {
  available: 'green',
  loading: 'blue',
  unavailable: 'yellow',
  unsupported: 'red',
  unknown: 'gray',
};

function AvailabilityBadge({ availability }: { availability: ResourceLoadAvailability }) {
  const suffix =
    availability.status === 'loading'
      ? ` ${Math.round(availability.progress * 100)}%`
      : availability.status === 'unavailable' && availability.queuePosition != null
      ? ` #${availability.queuePosition}`
      : '';

  return (
    <Badge color={statusColors[availability.status] ?? 'gray'}>
      {availability.status}
      {suffix}
    </Badge>
  );
}

/** Why a version cannot be loaded, in the order the server refuses. */
function loadBlockedReason(state: {
  eligible: boolean;
  loadable: boolean;
  unloadableReason?: UnloadableReason;
  availability: ResourceLoadAvailability;
}) {
  if (!state.eligible)
    return 'Not generatable on the site — coverage or the ecosystem does not support this model type.';
  if (!state.loadable) return UNLOADABLE_MESSAGES[state.unloadableReason ?? 'no-weights'];
  if (state.availability.status === 'unsupported') return 'The cluster cannot host this resource.';
  if (state.availability.status === 'unknown')
    return 'Could not read status from the orchestrator.';
  if (state.availability.status === 'available')
    return 'Already loaded and ready to generate with.';
  return null;
}

function LiveProgress({ live }: { live: ResourceLoadProgress }) {
  const pct = live.progress != null ? Math.round(live.progress * 100) : null;
  const eta = live.etaSeconds != null ? ` · ~${Math.round(live.etaSeconds / 60)}m left` : '';
  return (
    <Stack gap={4}>
      <Progress value={pct ?? 0} animated={pct != null} />
      <Text size="xs" c="dimmed">
        {live.queuePosition > 0
          ? `${live.queuePosition} download${live.queuePosition === 1 ? '' : 's'} ahead`
          : pct != null
          ? `Downloading — ${pct}%${eta}`
          : 'Transferring…'}
      </Text>
    </Stack>
  );
}

function SubmitCard({
  progress,
  onWatch,
}: {
  progress: Record<number, ResourceLoadProgress>;
  onWatch: (item: {
    modelVersionId: number;
    modelId: number;
    name: string;
    modelName: string;
    kind: 'requested' | 'watching';
  }) => void;
}) {
  const [modelVersionId, setModelVersionId] = useState<number | undefined>();
  const utils = trpc.useUtils();

  const { data: states, isFetching: isLooking } = trpc.resourceLoad.getState.useQuery(
    { modelVersionIds: [modelVersionId ?? 0] },
    { enabled: !!modelVersionId }
  );
  const state = states?.[0];
  const blocked = state ? loadBlockedReason(state) : null;
  const live = state ? progress[state.modelVersionId] : undefined;

  const estimate = trpc.resourceLoad.estimate.useMutation({
    onError: (error) =>
      showErrorNotification({ title: 'Could not estimate', error: new Error(error.message) }),
  });
  const submit = trpc.resourceLoad.submit.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        title: 'Load submitted',
        message: `${result.modelName} — ${result.name} (workflow ${
          result.workflowId ?? 'unknown'
        })`,
      });
      estimate.reset();
      onWatch({
        modelVersionId: result.modelVersionId,
        modelId: result.modelId,
        name: result.name,
        modelName: result.modelName,
        kind: 'requested',
      });
      utils.resourceLoad.getQueue.invalidate();
      utils.resourceLoad.getState.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not submit', error: new Error(error.message) }),
  });

  const quote = estimate.data;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Request a load</Title>
        <Group align="flex-end">
          <NumberInput
            label="Model version id"
            value={modelVersionId}
            onChange={(value) => {
              setModelVersionId(typeof value === 'number' ? value : undefined);
              estimate.reset();
            }}
            min={1}
            allowDecimal={false}
            className="flex-1"
          />
          <Button
            onClick={() => modelVersionId && estimate.mutate({ modelVersionId })}
            disabled={!state || !!blocked}
            loading={estimate.isPending}
          >
            Get estimate
          </Button>
        </Group>

        {isLooking && <Loader size="sm" />}

        {!isLooking && modelVersionId && !state && (
          <Text c="dimmed" size="sm">
            No model version with id {modelVersionId}.
          </Text>
        )}

        {state && (
          <Card withBorder padding="sm">
            <Stack gap="xs">
              <Group justify="space-between">
                <Text fw={500}>
                  <NextLink
                    href={`/models/${state.modelId}?modelVersionId=${state.modelVersionId}`}
                    target="_blank"
                  >
                    {state.modelName} — {state.name}
                  </NextLink>
                </Text>
                <AvailabilityBadge availability={state.availability} />
              </Group>
              <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                {state.air}
              </Text>
              <Group gap="xl">
                <Text size="sm">
                  Size: {state.size != null ? formatBytes(state.size) : 'unknown'}
                </Text>
                <Badge color={state.eligible ? 'green' : 'red'} variant="light">
                  {state.eligible ? 'generatable' : 'not generatable'}
                </Badge>
                <Badge color={state.loadable ? 'green' : 'red'} variant="light">
                  {state.loadable
                    ? 'has weights'
                    : state.unloadableReason === 'unsupported-format'
                    ? 'unsupported format'
                    : 'no weight file'}
                </Badge>
              </Group>

              {live && <LiveProgress live={live} />}

              {blocked && (
                <Alert color="gray" icon={<IconAlertTriangle size={16} />}>
                  {blocked}
                </Alert>
              )}

              {quote && quote.modelVersionId === state.modelVersionId && (
                <>
                  <Text size="sm">Cost: {quote.cost} Buzz</Text>
                  {!quote.priced && (
                    <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
                      The orchestrator quoted zero. Prepare steps are not priced yet (C2), so this
                      is not a price — submitting loads the model for free.
                    </Alert>
                  )}
                  <Group justify="flex-end">
                    <Button
                      leftSection={<IconDownload size={16} />}
                      onClick={() => submit.mutate({ modelVersionId: quote.modelVersionId })}
                      loading={submit.isPending}
                      disabled={!!blocked}
                    >
                      Submit load
                    </Button>
                  </Group>
                </>
              )}
            </Stack>
          </Card>
        )}
      </Stack>
    </Card>
  );
}

function TrackedCard({
  tracked,
  progress,
}: {
  tracked: TrackedResourceLoad[];
  progress: Record<number, ResourceLoadProgress>;
}) {
  const untrack = useResourceLoadStore((s) => s.untrack);
  if (!tracked.length) return null;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Waiting on ({tracked.length})</Title>
        <Text size="xs" c="dimmed">
          Kept in this browser and drained on every page load — finished loads are reported once and
          removed. The durable record of a purchased load is the orchestrator&apos;s.
        </Text>
        {tracked.map((item) => (
          <Group key={item.modelVersionId} justify="space-between" align="flex-start">
            <Stack gap={2} className="flex-1">
              <NextLink
                href={`/models/${item.modelId}?modelVersionId=${item.modelVersionId}`}
                target="_blank"
              >
                {item.modelName} — {item.name}
              </NextLink>
              {progress[item.modelVersionId] ? (
                <LiveProgress live={progress[item.modelVersionId]} />
              ) : (
                <Text size="xs" c="dimmed">
                  Requested {new Date(item.requestedAt).toLocaleString()}
                </Text>
              )}
            </Stack>
            <Button variant="subtle" size="compact-sm" onClick={() => untrack(item.modelVersionId)}>
              Stop watching
            </Button>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function QueueCard({ progress }: { progress: Record<number, ResourceLoadProgress> }) {
  const { data, isLoading, isRefetching, refetch } = trpc.resourceLoad.getQueue.useQuery(
    { take: 50 },
    { refetchInterval: QUEUE_POLL_MS }
  );

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Queue</Title>
          <Button
            variant="light"
            size="compact-sm"
            leftSection={<IconRefresh size={14} />}
            onClick={() => refetch()}
            loading={isRefetching}
          >
            Refresh
          </Button>
        </Group>

        <Text size="xs" c="dimmed">
          Every provider&apos;s queue, merged and ranked by the orchestrator. Rows whose AIR does
          not resolve to a model version on this site are dropped. Polls every{' '}
          {QUEUE_POLL_MS / 1000}s.
        </Text>

        {isLoading ? (
          <Loader />
        ) : !data?.items.length ? (
          <Text c="dimmed">Nothing loading or queued.</Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Model</Table.Th>
                <Table.Th>Version id</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Progress</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.items.map((item) => (
                <Table.Tr key={item.air}>
                  <Table.Td>
                    <NextLink
                      href={`/models/${item.modelId}?modelVersionId=${item.modelVersionId}`}
                      target="_blank"
                    >
                      {item.modelName} — {item.name}
                    </NextLink>
                  </Table.Td>
                  <Table.Td>{item.modelVersionId}</Table.Td>
                  <Table.Td>{item.size != null ? formatBytes(item.size) : 'unknown'}</Table.Td>
                  <Table.Td>
                    <AvailabilityBadge availability={item.availability} />
                  </Table.Td>
                  <Table.Td width={200}>
                    {progress[item.modelVersionId] ? (
                      <LiveProgress live={progress[item.modelVersionId]} />
                    ) : item.availability.status === 'loading' ? (
                      <Progress value={item.availability.progress * 100} />
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}

function ResourceLoadTestPage() {
  const progress = useResourceLoadProgress();
  // Drain is app-wide (ResourceLoadDrain, in the header); calling it here too would double-drain.
  const tracked = useResourceLoadStore((s) => s.tracked);
  const track = useResourceLoadStore((s) => s.track);

  return (
    <>
      <Meta title="Resource Loading" deIndex />
      <Container size="lg" py="xl">
        <Stack gap="xl">
          <Stack gap={0}>
            <Title order={2}>Resource Loading</Title>
            <Text c="dimmed" size="sm">
              Submit a model version to the generation cluster and watch what is loading or queued.
            </Text>
          </Stack>
          <SubmitCard progress={progress} onWatch={track} />
          <TrackedCard tracked={tracked} progress={progress} />
          <QueueCard progress={progress} />
        </Stack>
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(ResourceLoadTestPage, {
  features: (features) => features.resourceLoad,
});
