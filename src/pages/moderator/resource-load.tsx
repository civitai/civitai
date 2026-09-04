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
import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
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

function SubmitCard() {
  const [modelVersionId, setModelVersionId] = useState<number | undefined>();
  const utils = trpc.useUtils();

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
      utils.resourceLoad.getQueue.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not submit', error: new Error(error.message) }),
  });

  const quote = estimate.data;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Submit a load</Title>
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
            disabled={!modelVersionId}
            loading={estimate.isPending}
          >
            Get estimate
          </Button>
        </Group>

        {quote && (
          <Card withBorder padding="sm">
            <Stack gap="xs">
              <Group justify="space-between">
                <Text fw={500}>
                  <NextLink
                    href={`/models/${quote.modelId}?modelVersionId=${quote.modelVersionId}`}
                    target="_blank"
                  >
                    {quote.modelName} — {quote.name}
                  </NextLink>
                </Text>
                <AvailabilityBadge availability={quote.availability} />
              </Group>
              <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                {quote.air}
              </Text>
              <Group gap="xl">
                <Text size="sm">
                  Size: {quote.size != null ? formatBytes(quote.size) : 'unknown'}
                </Text>
                <Text size="sm">Cost: {quote.cost} Buzz</Text>
              </Group>

              {!quote.priced && (
                <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
                  The orchestrator quoted zero. Prepare steps are not priced yet (C2), so this is
                  not a price — submitting loads the model for free.
                </Alert>
              )}

              <Group justify="flex-end">
                <Button
                  leftSection={<IconDownload size={16} />}
                  onClick={() => submit.mutate({ modelVersionId: quote.modelVersionId })}
                  loading={submit.isPending}
                >
                  Submit load
                </Button>
              </Group>
            </Stack>
          </Card>
        )}
      </Stack>
    </Card>
  );
}

function QueueCard() {
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
                  <Table.Td width={160}>
                    {item.availability.status === 'loading' && (
                      <Progress value={item.availability.progress * 100} />
                    )}
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
          <SubmitCard />
          <QueueCard />
        </Stack>
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(ResourceLoadTestPage, {
  features: (features) => features.resourceLoad,
});
