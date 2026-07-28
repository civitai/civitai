import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconCamera, IconReload } from '@tabler/icons-react';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import type { ContestScoreSignal } from '~/server/schema/contest-score.schema';
import { contestScoreSignals } from '~/server/schema/contest-score.schema';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const signalLabels: Record<ContestScoreSignal, string> = {
  imageAuthors: 'Creators',
  reactors: 'Reactions',
  downloaders: 'Downloads',
  generators: 'Generations',
  collectors: 'Collects',
};

// Display-only banding for the qualification gap. Purely how loudly a row asks for
// staff eyes — it is not a scoring input and nothing is disqualified automatically.
function disqualifiedColor(share: number) {
  if (share >= 0.5) return 'red';
  if (share >= 0.25) return 'yellow';
  return 'gray';
}

export function ContestCommunityScore({ collectionId }: { collectionId: number }) {
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const filters = useMemo(
    () => ({
      collectionId,
      start: start ?? undefined,
      end: end ?? undefined,
    }),
    [collectionId, start, end]
  );

  const queryUtils = trpc.useUtils();
  const { data, isLoading, isFetching, error } = trpc.contestScore.getCommunityScore.useQuery(
    filters,
    { placeholderData: keepPreviousData }
  );
  const { data: snapshots } = trpc.contestScore.listSnapshots.useQuery({ collectionId });

  const snapshotMutation = trpc.contestScore.snapshot.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Snapshot saved' });
      await queryUtils.contestScore.listSnapshots.invalidate({ collectionId });
    },
    onError: (error) =>
      showErrorNotification({ title: 'Failed to snapshot', error: new Error(error.message) }),
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await queryUtils.contestScore.getCommunityScore.fetch({ ...filters, refresh: true });
      await queryUtils.contestScore.getCommunityScore.invalidate(filters);
    } catch (e) {
      showErrorNotification({ title: 'Failed to refresh', error: e as Error });
    } finally {
      setRefreshing(false);
    }
  };

  if (error)
    return (
      <Alert color="red" title="Community scoring unavailable">
        {error.message}
      </Alert>
    );

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Text c="dimmed" size="sm">
          Entries ranked by distinct qualified users per signal, normalized within each category.
          Raw counts include engagement that failed qualification; a large gap is a prompt for human
          review, never an automatic disqualification.
        </Text>
        <Group gap="sm" align="flex-end">
          <DatePickerInput
            label="Window start"
            placeholder="Collection start"
            value={start}
            onChange={setStart}
            clearable
            maxDate={end ?? undefined}
          />
          <DatePickerInput
            label="Window end"
            placeholder="Now"
            value={end}
            onChange={setEnd}
            clearable
            minDate={start ?? undefined}
          />
          <Button
            variant="light"
            leftSection={<IconReload size={16} />}
            loading={refreshing}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
          <Button
            variant="light"
            leftSection={<IconCamera size={16} />}
            loading={snapshotMutation.isPending}
            onClick={() => snapshotMutation.mutate(filters)}
          >
            Snapshot
          </Button>
        </Group>
      </Stack>

      {data?.partial && (
        <Alert color="orange" title="Preview — the contest is still open">
          Scored up to {formatDate(data.window.effectiveEnd, 'MMM D, YYYY h:mm A')}. These standings
          are not a final result.
        </Alert>
      )}

      {data?.truncated && (
        <Alert color="yellow">
          Showing the first {data.entryCount} entries only. Narrow the category or status filter to
          score the rest.
        </Alert>
      )}

      {isLoading || isFetching ? (
        <Center py="xl">
          <Loader size="xl" />
        </Center>
      ) : !data?.categories.length ? (
        <NoContent message="No entries matched this window" />
      ) : (
        data.categories.map((category) => (
          <Paper key={category.tagId ?? 'uncategorized'} withBorder p="md" radius="md">
            <Stack gap="sm">
              <Group justify="space-between">
                <Title order={4}>{category.tagName ?? 'Uncategorized'}</Title>
                <Text size="sm" c="dimmed">
                  {category.eligibleCount} eligible of {category.entryCount}
                </Text>
              </Group>
              {category.soloEntry && (
                <Alert color="yellow">
                  Only one eligible entry in this category. A lone entrant tops every signal by
                  definition, so its score is not comparable to any other category.
                </Alert>
              )}
              {category.tied && (
                <Alert color="gray">
                  No qualified engagement in this category — every entry is tied, so no ranking is
                  shown.
                </Alert>
              )}
              <Table.ScrollContainer minWidth={900}>
                <Table striped highlightOnHover verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>#</Table.Th>
                      <Table.Th>Entry</Table.Th>
                      {contestScoreSignals.map((signal) => (
                        <Table.Th key={signal}>
                          <Tooltip label={data.signalSources[signal]} withArrow>
                            <span>{signalLabels[signal]}</span>
                          </Tooltip>
                        </Table.Th>
                      ))}
                      <Table.Th>Total</Table.Th>
                      <Table.Th>Gap</Table.Th>
                      <Table.Th>Score</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {category.entries.map((entry) => (
                      <Table.Tr key={entry.collectionItemId} opacity={entry.eligible ? 1 : 0.55}>
                        <Table.Td>{entry.rank ?? '—'}</Table.Td>
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            {entry.image && (
                              <EdgeMedia
                                src={entry.image.url}
                                type={entry.image.type as MediaType}
                                width={64}
                                className="size-10 rounded object-cover"
                              />
                            )}
                            <Stack gap={0}>
                              <Link
                                href={`/models/${entry.modelId}`}
                                target="_blank"
                                className="font-medium"
                              >
                                {entry.modelName}
                              </Link>
                              {entry.creatorUsername && (
                                <Text size="xs" c="dimmed">
                                  by {entry.creatorUsername}
                                </Text>
                              )}
                              {entry.ineligibleReason && (
                                <Badge color="red" variant="light" size="xs">
                                  {entry.ineligibleReason}
                                </Badge>
                              )}
                            </Stack>
                          </Group>
                        </Table.Td>
                        {contestScoreSignals.map((signal) => (
                          <Table.Td key={signal}>
                            <Text size="sm">
                              {entry.signals[signal].qualified}
                              <Text span size="xs" c="dimmed">
                                {' '}
                                / {entry.signals[signal].raw}
                              </Text>
                            </Text>
                          </Table.Td>
                        ))}
                        <Table.Td>
                          <Text size="sm">
                            {entry.qualifiedTotal}
                            <Text span size="xs" c="dimmed">
                              {' '}
                              / {entry.rawTotal}
                            </Text>
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label="Share of engagement that failed qualification" withArrow>
                            <Badge
                              color={disqualifiedColor(entry.disqualifiedShare)}
                              variant="light"
                            >
                              {Math.round(entry.disqualifiedShare * 100)}%
                            </Badge>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          <Text fw={600}>{entry.eligible ? entry.score.toFixed(3) : '—'}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Stack>
          </Paper>
        ))
      )}

      <Paper withBorder p="md" radius="md">
        <Stack gap="xs">
          <Title order={5}>Snapshots</Title>
          {!snapshots?.length ? (
            <Text size="sm" c="dimmed">
              No snapshots taken yet.
            </Text>
          ) : (
            snapshots.map((snapshot) => (
              <Group key={snapshot.key} gap="xs" justify="space-between">
                <Group gap="xs">
                  <Text size="sm">
                    {formatDate(snapshot.takenAt, 'MMM D, YYYY h:mm A')} &middot;{' '}
                    {snapshot.takenByUsername ?? `user ${snapshot.takenById}`}
                  </Text>
                  {snapshot.partial && (
                    <Badge color="orange" variant="light" size="xs">
                      Preview
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {snapshot.entryCount} entries &middot; {formatDate(snapshot.window.start)} –{' '}
                  {formatDate(snapshot.window.effectiveEnd)}
                </Text>
              </Group>
            ))
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
