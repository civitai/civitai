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
// Value imports here must never reach `~/server/services/contest-score.service`: it pulls
// `~/server/db/client` and `~/env/server`, neither of which can be tree-shaken (both run
// side effects at import), and the resulting client bundle only fails at `next build`.
// Every other import from that module in this file is `import type` and erases.
import {
  CONTEST_SCORE_CODE_VERSION,
  CONTEST_VERSION_SCOPING_CODE_VERSION,
} from '~/server/common/constants';
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

/**
 * A stored snapshot is whatever the code that took it wrote. Nothing parses, migrates
 * or backfills it on read, so every field added since the first snapshot is genuinely
 * absent on older ones — and the types below say so, because the payload types do not.
 *
 * Treating them as present is how a display bug becomes a dead panel: dereferencing one
 * missing field above the tables takes down the whole artifact we keep to settle a
 * disputed placement. Render what is missing as missing, never as zero.
 */
type StoredEntry = Omit<ContestScoreEntry, 'qualifyingVersionCount'> & {
  qualifyingVersionCount?: number;
};
type StoredCategory = Omit<ContestScoreCategory, 'entries'> & { entries: StoredEntry[] };
type StoredScore = Omit<ContestCommunityScoreResult, 'eligibility' | 'categories'> & {
  eligibility?: ContestCommunityScoreResult['eligibility'];
  categories: StoredCategory[];
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

const sortValue = (entry: StoredEntry, column: SortColumn) => {
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
function sortEntries(entries: StoredEntry[], sort: Sort) {
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
  category: StoredCategory;
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
        {category.truncated && (
          <Alert color="red" title="This category is incomplete — ranks withheld">
            {category.missingCount} {category.missingCount === 1 ? 'entry is' : 'entries are'}{' '}
            missing from this run because the contest exceeded the per-run entry ceiling. Scores are
            normalized against the entries that survived, so every score here is wrong by an unknown
            amount. Narrow the window and run again before using this category.
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
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Text size="sm">{entry.rank ?? '—'}</Text>
                      {entry.sharedRank && (
                        <Tooltip
                          label="Tied on score with another entry — they share this rank"
                          withArrow
                        >
                          <Badge color="yellow" variant="light" size="xs">
                            tie
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
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
                        {entry.qualifyingVersionCount === undefined ? (
                          <Tooltip
                            label="This run predates version scoping, so it counted every version of the model."
                            withArrow
                            multiline
                            w={260}
                          >
                            <Text size="xs" c="dimmed" fs="italic" w="fit-content">
                              versions not recorded
                            </Text>
                          </Tooltip>
                        ) : (
                          <Tooltip
                            label="Versions created during the contest window on a qualifying base model. Only these are counted."
                            withArrow
                            multiline
                            w={260}
                          >
                            <Text size="xs" c="dimmed" w="fit-content">
                              {entry.qualifyingVersionCount}{' '}
                              {entry.qualifyingVersionCount === 1 ? 'version' : 'versions'}
                            </Text>
                          </Tooltip>
                        )}
                        {entry.ineligibleReason && (
                          <Badge
                            color="red"
                            variant="light"
                            size="xs"
                            h="auto"
                            classNames={{ label: 'whitespace-normal' }}
                            className="py-0.5"
                          >
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
                    <Group gap={4} wrap="nowrap">
                      <Text fw={600}>{entry.eligible ? entry.score.toFixed(3) : '—'}</Text>
                      {entry.belowDisplayPrecision && (
                        <Tooltip
                          label="An adjacent entry's score differs only below the precision shown here. Do not separate them on this number alone."
                          withArrow
                        >
                          <Badge color="orange" variant="light" size="xs">
                            ~
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
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

const boundSourceLabels: Record<ContestCommunityScoreResult['eligibility']['startSource'], string> =
  {
    submissionStartDate: 'contest submission start',
    submissionEndDate: 'contest submission end',
    endsAt: 'contest end date',
    collectionCreatedAt: 'collection creation date (no submission start is set)',
  };

/**
 * The two windows, side by side. Which dates decided ELIGIBILITY is not inferable from
 * the pickers — narrowing them changes only what was counted — so the header says it
 * outright rather than leaving a moderator to assume the one they set is both.
 */
function WindowSummary({ score }: { score: StoredScore }) {
  const eligibility = score.eligibility;
  return (
    <Group gap="xl">
      <Stack gap={0}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          Eligibility window
        </Text>
        {eligibility ? (
          <>
            <Text size="sm">
              {formatDate(eligibility.start)} – {formatDate(eligibility.end)}
            </Text>
            <Text size="xs" c="dimmed">
              Versions created here qualify · from {boundSourceLabels[eligibility.startSource]} to{' '}
              {boundSourceLabels[eligibility.endSource]}
            </Text>
          </>
        ) : (
          <>
            <Text size="sm" fs="italic" c="dimmed">
              Not recorded
            </Text>
            <Text size="xs" c="dimmed">
              This run predates the eligibility window being tracked
            </Text>
          </>
        )}
      </Stack>
      <Stack gap={0}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          Counted window
        </Text>
        <Text size="sm">
          {formatDate(score.window.start)} – {formatDate(score.window.effectiveEnd)}
        </Text>
        <Text size="xs" c="dimmed">
          Traffic counted · narrowing this never changes eligibility
        </Text>
      </Stack>
    </Group>
  );
}

/**
 * `snapshot` is passed only for a STORED result — a live one is current by definition.
 * Its `codeVersion` is what distinguishes a snapshot that counted every version of a
 * model from one that did not, and an absent version is treated as the oldest case
 * rather than the newest: a row too old to record it is certainly older than the fix.
 */
function ScoreBody({
  score,
  snapshot,
}: {
  score: StoredScore;
  snapshot?: { codeVersion?: number };
}) {
  const codeVersion = snapshot?.codeVersion;
  const stale = !!snapshot && (codeVersion ?? 0) < CONTEST_SCORE_CODE_VERSION;
  const preVersionScoping = !!snapshot && (codeVersion ?? 0) < CONTEST_VERSION_SCOPING_CODE_VERSION;

  return (
    <Stack gap="lg">
      {stale && (
        <Alert
          color={preVersionScoping ? 'red' : 'yellow'}
          title={
            preVersionScoping
              ? 'Taken before the version-scoping fix'
              : 'Taken by an older version of the scorer'
          }
        >
          {preVersionScoping
            ? 'Counts here include every version of each model, not only versions created during the contest on a qualifying base model. Entries carrying an older, unrelated version are overstated. Do not compare these standings to a current run.'
            : 'Scoring has changed since this snapshot was taken, so its standings are not directly comparable to a current run.'}{' '}
          (scorer {codeVersion === undefined ? 'version not recorded' : `v${codeVersion}`}, current
          v{CONTEST_SCORE_CODE_VERSION})
        </Alert>
      )}
      <WindowSummary score={score} />
      {/* Driven by the score itself, not by the live query, so a snapshot taken
          mid-contest carries the same warning as the live view it came from. */}
      {score.partial && (
        <Alert color="orange" title="Preview — the contest was still open">
          Scored up to {formatDate(score.window.effectiveEnd, 'MMM D, YYYY h:mm A')}. These
          standings are not a final result.
        </Alert>
      )}
      {score.truncated.entries && (
        <Alert color="red" title="Entries were dropped from this run">
          This contest has more entries than a single run scores, so the {score.entryCount} oldest
          were kept and the newest dropped. Affected categories have their ranks withheld. Narrow
          the window and run again.
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
  const [configOpen, setConfigOpen] = useState<string | null>(null);

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
          Accepted entries only, ranked by distinct qualified users per signal and normalized within
          each category. Entries still in review and rejected entries are not scored. Raw counts
          include engagement that failed qualification; a large gap is a prompt for human review,
          never an automatic disqualification.
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

      {/* Controlled, and the editor is mounted only while open: an always-mounted
          panel would fetch the config and put its values in every moderator's browser
          on tab open, whether or not anyone asked to see them. */}
      <Accordion variant="contained" value={configOpen} onChange={setConfigOpen}>
        <Accordion.Item value="config">
          <Accordion.Control>Scoring configuration</Accordion.Control>
          <Accordion.Panel>
            {configOpen === 'config' && <ContestScoringConfigEditor collectionId={collectionId} />}
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
                  {ref.partial && (
                    <Tooltip label="Taken while the contest was still open" withArrow>
                      <Badge color="orange" variant="light" size="xs">
                        Partial
                      </Badge>
                    </Tooltip>
                  )}
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
                  {(snapshot.codeVersion ?? 0) < CONTEST_SCORE_CODE_VERSION && (
                    <Tooltip label="Scoring has changed since this snapshot was taken" withArrow>
                      <Badge color="red" variant="light" size="xs">
                        {snapshot.codeVersion === undefined
                          ? 'Scorer version unknown'
                          : `Scorer v${snapshot.codeVersion}`}
                      </Badge>
                    </Tooltip>
                  )}
                  {snapshot.note && <Badge variant="light">{snapshot.note}</Badge>}
                </Group>
                <ScoreBody score={snapshot.score} snapshot={snapshot} />
              </>
            )}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
