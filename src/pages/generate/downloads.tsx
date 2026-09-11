import {
  Alert,
  Badge,
  Card,
  Container,
  Loader,
  Progress,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import * as z from 'zod';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  DownloadLanesExplainer,
  downloadLaneLabel,
} from '~/components/ResourceLoad/download-lanes';
import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDownloadEta } from '~/components/ResourceLoad/download-eta';
import { describeResidency } from '~/components/ResourceLoad/ResourceResidency';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { formatBytes } from '~/utils/number-helpers';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const QUEUE_POLL_MS = 15_000;

const querySchema = z.object({ versions: commaDelimitedNumberArray().optional() });

function laneOf(availability: ResourceLoadAvailability) {
  return availability.status === 'queued' || availability.status === 'loading'
    ? availability.lane
    : undefined;
}

function StatusCell({ availability }: { availability: ResourceLoadAvailability }) {
  if (availability.status === 'loading') {
    const pct = Math.round(availability.progress * 100);
    return (
      <Stack gap={2}>
        <Progress value={pct} animated size="sm" />
        <Text size="xs" c="dimmed">
          Downloading · {pct}%
          {availability.etaSeconds != null &&
            ` · ${formatDownloadEta(availability.etaSeconds)} left`}
        </Text>
      </Stack>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      {describeResidency(availability)?.label ?? 'Waiting'}
      {availability.status === 'queued' &&
        availability.etaSeconds != null &&
        ` · ready in ${formatDownloadEta(availability.etaSeconds)}`}
    </Text>
  );
}

function DownloadQueuePage() {
  const { query } = useZodRouteParams(querySchema);
  const highlighted = new Set(query.versions ?? []);
  const { data, isLoading, isError } = trpc.resourceLoad.getPublicQueue.useQuery(undefined, {
    refetchInterval: QUEUE_POLL_MS,
  });

  return (
    <>
      <Meta title="Model downloads" deIndex />
      <Container size="md" py="xl">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>Model downloads</Title>
            <Text c="dimmed" size="sm">
              What the generator is downloading now and what is waiting. A generation that needs one
              of these models waits in your queue until its download finishes.
            </Text>
          </Stack>

          <Card withBorder>
            <DownloadLanesExplainer />
          </Card>

          {isLoading ? (
            <Loader />
          ) : isError ? (
            <Alert color="red">Could not load the download queue. Try again in a moment.</Alert>
          ) : !data?.items.length ? (
            <Text c="dimmed">Nothing is downloading right now.</Text>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>#</Table.Th>
                    <Table.Th>Model</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th>Lane</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.items.map((item, index) => {
                    const mine = !!item.model && highlighted.has(item.model.versionId);
                    return (
                      <Table.Tr
                        key={index}
                        style={
                          mine ? { background: 'var(--mantine-color-yellow-light)' } : undefined
                        }
                      >
                        <Table.Td>{index + 1}</Table.Td>
                        <Table.Td>
                          {item.model ? (
                            <>
                              <NextLink
                                href={getModelUrl({
                                  modelId: item.model.id,
                                  modelName: item.model.name,
                                  modelVersionId: item.model.versionId,
                                })}
                              >
                                {item.model.name} — {item.model.versionName}
                              </NextLink>
                              {mine && (
                                <Badge size="xs" color="yellow" ml={6}>
                                  Yours
                                </Badge>
                              )}
                              <Text size="xs" c="dimmed">
                                {item.model.baseModel}
                              </Text>
                            </>
                          ) : (
                            <Text size="sm" c="dimmed">
                              Unlisted model
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>{formatBytes(item.size)}</Table.Td>
                        <Table.Td>{downloadLaneLabel(laneOf(item.availability)) ?? '—'}</Table.Td>
                        <Table.Td miw={180}>
                          <StatusCell availability={item.availability} />
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Stack>
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({ useSession: true });

export default Page(DownloadQueuePage, {
  features: (features) => features.imageGeneration,
});
