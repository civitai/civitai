import {
  Accordion,
  ActionIcon,
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
  UnstyledButton,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconCamera,
  IconChevronDown,
  IconChevronUp,
  IconPlayerPlay,
  IconX,
} from '@tabler/icons-react';
import { keepPreviousData } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { ContestScoringConfigEditor } from '~/components/Collections/components/ContestCollections/ContestScoringConfigEditor';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type {
  ContestScoreRunState,
  ContestScoreSignal,
} from '~/server/schema/contest-score.schema';
import { contestScoreSignals } from '~/server/schema/contest-score.schema';
import type {
  ContestCommunityScore as ContestCommunityScoreResult,
  ContestScoreCategory,
  ContestScoreEntry,
} from '~/server/services/contest-score.service';
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

type SortColumn = 'rank' | 'entry' | 'total' | 'gap' | 'score' | ContestScoreSignal;
type Sort = { column: SortColumn; desc: boolean };

const sortValue = (entry: ContestScoreEntry, column: SortColumn) => {
  switch (column) {
    case 'rank':
      return entry.rank ?? Number.MAX_SAFE_INTEGER;
    case 'entry':
      return entry.modelName.toLowerCase();
    case 'total':
      return entry.qualifiedTotal;
    case 'gap':
      return entry.disqualifiedShare;
    case 'score':
      return entry.score;
    default:
      return entry.signals[column].qualified;
  }
};

/**
 * Every run returns its category ranked in full, so re-sorting a column is a pure
 * client-side reorder — no refetch, and the server never learns which column a
 * moderator is looking at.
 */
function sortEntries(entries: ContestScoreEntry[], sort: Sort) {
  return [...entries].sort((a, b) => {
    const left = sortValue(a, sort.column);
    const right = sortValue(b, sort.column);
    const cmp =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right)
        : Number(left) - Number(right);
    return sort.desc ? -cmp : cmp;
  });
}

function SortableTh({
  column,
  sort,
  onSort,
  children,
}: {
  column: SortColumn;
  sort: Sort;
  onSort: (column: SortColumn) => void;
  children: React.ReactNode;
}) {
  const active = sort.column === column;
  return (
    <Table.Th>
      <UnstyledButton onClick={() => onSort(column)} className="w-full">
        <Group gap={4} wrap="nowrap">
          <Text size="sm" fw={active ? 700 : 500}>
            {children}
          </Text>
          {active && (sort.desc ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />)}
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
}

function CategoryTable({
  category,
  signalSources,
}: {
  category: ContestScoreCategory;
  signalSources: Record<ContestScoreSignal, string>;
}) {
  const [sort, setSort] = useState<Sort>({ column: 'rank', desc: false });
  const entries = useMemo(() => sortEntries(category.entries, sort), [category.entries, sort]);

  const onSort = useCallback(
    (column: SortColumn) =>
      setSort((current) =>
        current.column === column
          ? { column, desc: !current.desc }
          : { column, desc: column !== 'rank' && column !== 'entry' }
      ),
    []
  );

  return (
    <Paper withBorder p="md" radius="md">
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
            No qualified engagement in this category — every entry is tied, so no ranking is shown.
          </Alert>
        )}
        <Table.ScrollContainer minWidth={900}>
          <Table striped highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <SortableTh column="rank" sort={sort} onSort={onSort}>
                  #
                </SortableTh>
                <SortableTh column="entry" sort={sort} onSort={onSort}>
                  Entry
                </SortableTh>
                {contestScoreSignals.map((signal) => (
                  <SortableTh key={signal} column={signal} sort={sort} onSort={onSort}>
                    <Tooltip label={signalSources[signal]} withArrow>
                      <span>{signalLabels[signal]}</span>
                    </Tooltip>
                  </SortableTh>
                ))}
                <SortableTh column="total" sort={sort} onSort={onSort}>
                  Total
                </SortableTh>
                <SortableTh column="gap" sort={sort} onSort={onSort}>
                  Gap
                </SortableTh>
                <SortableTh column="score" sort={sort} onSort={onSort}>
                  Score
                </SortableTh>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((entry) => (
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
                      <Badge color={disqualifiedColor(entry.disqualifiedShare)} variant="light">
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
  );
}

function ScoreBody({ score }: { score: ContestCommunityScoreResult }) {
  return (
    <Stack gap="lg">
      {score.truncated.entries && (
        <Alert color="yellow">
          Showing the first {score.entryCount} entries only. Narrow the category or status filter to
          score the rest.
        </Alert>
      )}
      {score.truncated.images && (
        <Alert color="yellow" title="Image set truncated">
          This contest published more images in the window than a single run counts, so reaction
          counts are incomplete. Narrow the window.
        </Alert>
      )}
      {score.degraded.bannedRefinementSkipped && (
        <Alert color="red" title="Banned-account filtering was skipped">
          Too many distinct engagers to resolve account status for this run. Counts still exclude
          new, excluded and contest-banned accounts, but not banned or deleted ones. Do not decide a
          prize on this run.
        </Alert>
      )}
      {!score.categories.length ? (
        <NoContent message="No entries matched this window" />
      ) : (
        score.categories.map((category) => (
          <CategoryTable
            key={category.tagId ?? 'uncategorized'}
            category={category}
            signalSources={score.signalSources}
          />
        ))
      )}
    </Stack>
  );
}

function runLabel(run: ContestScoreRunState) {
  if (run.status === 'queued') return 'Run queued…';
  if (run.status === 'running') return 'Scoring run in progress…';
  return null;
}

export function ContestCommunityScore({ collectionId }: { collectionId: number }) {
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      collectionId,
      start: start ?? undefined,
      end: end ?? undefined,
    }),
    [collectionId, start, end]
  );

  const queryUtils = trpc.useUtils();
  const { data, isLoading, error } = trpc.contestScore.getCommunityScore.useQuery(filters, {
    placeholderData: keepPreviousData,
  });
  const { data: snapshots } = trpc.contestScore.listSnapshots.useQuery({ collectionId });
  const { data: snapshot, isLoading: loadingSnapshot } = trpc.contestScore.getSnapshot.useQuery(
    { collectionId, key: snapshotKey ?? '' },
    { enabled: !!snapshotKey }
  );

  useSignalTopic(`${SignalTopic.ContestScore}:${collectionId}`);
  useSignalConnection(
    SignalMessages.ContestScoreRunUpdate,
    useCallback(
      (state: ContestScoreRunState) => {
        if (state.collectionId !== collectionId) return;
        // The signal carries run bookkeeping only, so a finished run is a prompt to
        // refetch the moderator-gated result rather than a result in itself.
        queryUtils.contestScore.getCommunityScore.invalidate({ collectionId }).catch(() => null);
      },
      [collectionId, queryUtils]
    )
  );

  const runMutation = trpc.contestScore.runCommunityScore.useMutation({
    onSuccess: async () => {
      await queryUtils.contestScore.getCommunityScore.invalidate({ collectionId });
    },
    onError: (error) =>
      showErrorNotification({ title: 'Failed to start run', error: new Error(error.message) }),
  });

  const snapshotMutation = trpc.contestScore.snapshot.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Snapshot saved' });
      await queryUtils.contestScore.listSnapshots.invalidate({ collectionId });
    },
    onError: (error) =>
      showErrorNotification({ title: 'Failed to snapshot', error: new Error(error.message) }),
  });

  if (error)
    return (
      <Alert color="red" title="Community scoring unavailable">
        {error.message}
      </Alert>
    );

  const run = data?.run ?? null;
  const result = data?.result ?? null;
  const inFlight = runMutation.isPending || run?.status === 'queued' || run?.status === 'running';

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
            leftSection={<IconPlayerPlay size={16} />}
            loading={inFlight}
            onClick={() => runMutation.mutate(filters)}
          >
            Run scoring
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

      {run && runLabel(run) && (
        <Alert color="blue">
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm">
              {runLabel(run)}
              {result
                ? ` Showing the run from ${formatDate(
                    result.generatedAt,
                    'MMM D, YYYY h:mm A'
                  )} until it finishes.`
                : ''}
            </Text>
          </Group>
        </Alert>
      )}

      {run?.status === 'failed' && (
        <Alert color="red" title="The last run failed">
          {run.error}
        </Alert>
      )}

      {result?.partial && (
        <Alert color="orange" title="Preview — the contest is still open">
          Scored up to {formatDate(result.window.effectiveEnd, 'MMM D, YYYY h:mm A')}. These
          standings are not a final result.
        </Alert>
      )}

      {isLoading ? (
        <Center py="xl">
          <Loader size="xl" />
        </Center>
      ) : !result ? (
        <NoContent message="No scoring run for this window yet. Run scoring to produce one." />
      ) : (
        <Stack gap="lg">
          <Text size="xs" c="dimmed">
            Scored {formatDate(result.generatedAt, 'MMM D, YYYY h:mm A')} &middot;{' '}
            {result.entryCount} entries
          </Text>
          <ScoreBody score={result} />
        </Stack>
      )}

      <Accordion variant="contained">
        <Accordion.Item value="config">
          <Accordion.Control>Scoring configuration</Accordion.Control>
          <Accordion.Panel>
            <ContestScoringConfigEditor collectionId={collectionId} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <Paper withBorder p="md" radius="md">
        <Stack gap="xs">
          <Title order={5}>Snapshots</Title>
          {!snapshots?.length ? (
            <Text size="sm" c="dimmed">
              No snapshots taken yet.
            </Text>
          ) : (
            snapshots.map((ref) => (
              <Group key={ref.key} gap="xs" justify="space-between">
                <Group gap="xs">
                  <UnstyledButton onClick={() => setSnapshotKey(ref.key)}>
                    <Text size="sm" td={snapshotKey === ref.key ? 'underline' : undefined}>
                      {formatDate(ref.takenAt, 'MMM D, YYYY h:mm A')}
                    </Text>
                  </UnstyledButton>
                  {ref.source && (
                    <Badge color="grape" variant="light" size="xs">
                      {ref.source}
                    </Badge>
                  )}
                </Group>
              </Group>
            ))
          )}
        </Stack>
      </Paper>

      {snapshotKey && (
        <Paper withBorder p="md" radius="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Title order={5}>
                Snapshot {formatDate(snapshot?.takenAt ?? snapshotKey, 'MMM D, YYYY h:mm A')}
              </Title>
              <ActionIcon variant="subtle" onClick={() => setSnapshotKey(null)}>
                <IconX size={16} />
              </ActionIcon>
            </Group>
            {loadingSnapshot || !snapshot ? (
              <Center py="lg">
                <Loader />
              </Center>
            ) : (
              <>
                <Group gap="xs">
                  <Text size="sm" c="dimmed">
                    Taken by {snapshot.takenByUsername ?? `user ${snapshot.takenById}`} &middot;{' '}
                    {snapshot.entryCount} entries &middot; {formatDate(snapshot.window.start)} –{' '}
                    {formatDate(snapshot.window.effectiveEnd)}
                  </Text>
                  {snapshot.partial && (
                    <Badge color="orange" variant="light" size="xs">
                      Partial
                    </Badge>
                  )}
                  {snapshot.note && <Badge variant="light">{snapshot.note}</Badge>}
                </Group>
                <ScoreBody score={snapshot.score} />
              </>
            )}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
