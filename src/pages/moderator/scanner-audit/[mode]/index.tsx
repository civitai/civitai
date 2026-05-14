/**
 * Scanner audit table for one mode (text / prompt / media). Tabs at the top
 * navigate between modes. Triggered / Near-miss sub-tabs filter the rows.
 * Click a label cell → /moderator/scanner-audit/[mode]/[label] for focused
 * review of that label.
 */
import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconDownload, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import {
  ScannerAuditLayout,
  isValidMode,
  modeToScanner,
  type ScannerAuditMode,
} from '~/components/Moderator/ScannerAuditLayout';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { QueueView } from '~/server/schema/scanner-review.schema';
import type { QueueRow } from '~/server/services/scanner-review.service';
import { ReviewVerdict } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

const PAGE_SIZE = 50;

type Filters = {
  label: string;
  version: string;
};

function ScannerAuditTablePage() {
  const router = useRouter();
  const modeParam = Array.isArray(router.query.mode) ? router.query.mode[0] : router.query.mode;
  const mode: ScannerAuditMode = isValidMode(modeParam) ? modeParam : 'text';
  const scanner = modeToScanner(mode);

  const [view, setView] = useState<QueueView>('triggered');
  // `draftFilters` tracks the input boxes; `filters` is what actually drives
  // the query. They sync only when the mod clicks Search or hits Enter — that
  // way typing "csam" doesn't fire one query per keystroke against ClickHouse.
  const [draftFilters, setDraftFilters] = useState<Filters>({ label: '', version: '' });
  const [filters, setFilters] = useState<Filters>({ label: '', version: '' });
  const [page, setPage] = useState(1);

  const applyFilters = () => {
    setFilters(draftFilters);
    setPage(1);
  };

  const queryInput = useMemo(
    () => ({
      view,
      scanner,
      label: filters.label || undefined,
      version: filters.version || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [view, scanner, filters, page]
  );

  const { data, isFetching } = trpc.scannerReview.list.useQuery(queryInput);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <Meta title="Scanner Audit" deIndex />
      <ScannerAuditLayout activeMode={mode} rightAction={<ExportButton view={view} mode={mode} filters={filters} />}>
        <Group align="end">
          <TextInput
            label="Label"
            placeholder="e.g. csam"
            value={draftFilters.label}
            onChange={(e) => {
              // Capture the value synchronously; React's synthetic event is
              // recycled by the time the updater function runs, so
              // `e.currentTarget` would be null inside it.
              const value = e.currentTarget.value;
              setDraftFilters((f) => ({ ...f, label: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters();
            }}
            size="xs"
            w={200}
          />
          <TextInput
            label="Policy version"
            placeholder="version"
            value={draftFilters.version}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setDraftFilters((f) => ({ ...f, version: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters();
            }}
            size="xs"
            w={240}
          />
          <Button size="xs" onClick={applyFilters} loading={isFetching}>
            Search
          </Button>
        </Group>

        <Tabs
          value={view}
          onChange={(v) => {
            if (v) {
              setView(v as QueueView);
              setPage(1);
            }
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="triggered">Triggered (FP review)</Tabs.Tab>
            <Tabs.Tab value="near-miss">Near-miss (FN review)</Tabs.Tab>
          </Tabs.List>
        </Tabs>

        {!data && isFetching ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : data && data.rows.length === 0 ? (
          <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
            No {view === 'triggered' ? 'triggered' : 'near-miss'} decisions match the current
            filters in the last 30 days.
          </Alert>
        ) : (
          <Box pos="relative">
            <LoadingOverlay visible={isFetching} zIndex={5} overlayProps={{ blur: 1 }} />
            <Stack gap="sm">
              <Table striped withTableBorder highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Label</Table.Th>
                  <Table.Th>Score</Table.Th>
                  <Table.Th>Threshold</Table.Th>
                  <Table.Th>Occurrences</Table.Th>
                  <Table.Th>Policy</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last seen</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.rows.map((r) => (
                  <Table.Tr key={`${r.contentHash}::${r.version}::${r.label}`}>
                    <Table.Td>
                      <Link
                        href={`/moderator/scanner-audit/${mode}/${encodeURIComponent(r.label)}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        <code style={{ textDecoration: 'underline', cursor: 'pointer' }}>
                          {r.label}
                        </code>
                      </Link>
                      {r.labelValue && (
                        <Text size="xs" c="dimmed" component="span" ml={4}>
                          = {r.labelValue}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{r.score.toFixed(3)}</Table.Td>
                    <Table.Td>{r.threshold !== null ? r.threshold.toFixed(2) : '—'}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.occurrences.toLocaleString()}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={r.version || '(none)'}>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {r.version ? `${r.version.slice(0, 10)}…` : '—'}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {r.myVerdict && (
                          <Badge size="xs" color={verdictColor(r.myVerdict)}>
                            {verdictShort(r.myVerdict)}
                          </Badge>
                        )}
                        {!r.myVerdict && r.anyVerdict && (
                          <Tooltip label="Verdict from another moderator">
                            <Badge
                              size="xs"
                              color={verdictColor(r.anyVerdict)}
                              variant="outline"
                            >
                              {verdictShort(r.anyVerdict)}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {new Date(r.lastSeenAt).toLocaleString()}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {data ? `${data.total.toLocaleString()} matching decisions` : '—'}
              </Text>
              <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
            </Group>
            </Stack>
          </Box>
        )}
      </ScannerAuditLayout>
    </>
  );
}

function ExportButton({
  view,
  mode,
  filters,
}: {
  view: QueueView;
  mode: ScannerAuditMode;
  filters: Filters;
}) {
  const utils = trpc.useUtils();
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const result = await utils.scannerReview.exportRows.fetch({
        view,
        scanner: modeToScanner(mode),
        label: filters.label || undefined,
        version: filters.version || undefined,
        limit: 50000,
        offset: 0,
      });
      const csv = toCsv(result.rows);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scanner-audit-${mode}-${view}-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showErrorNotification({ title: 'Export failed', error: err as Error });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      variant="default"
      leftSection={<IconDownload size={14} />}
      loading={loading}
      onClick={handleExport}
      size="xs"
    >
      Export CSV
    </Button>
  );
}

function verdictColor(v: ReviewVerdict): string {
  switch (v) {
    case ReviewVerdict.TruePositive:
    case ReviewVerdict.TrueNegative:
      return 'green';
    case ReviewVerdict.FalsePositive:
    case ReviewVerdict.FalseNegative:
      return 'red';
    case ReviewVerdict.Unsure:
    default:
      return 'gray';
  }
}

function verdictShort(v: ReviewVerdict): string {
  switch (v) {
    case ReviewVerdict.TruePositive:
      return 'TP';
    case ReviewVerdict.FalsePositive:
      return 'FP';
    case ReviewVerdict.TrueNegative:
      return 'TN';
    case ReviewVerdict.FalseNegative:
      return 'FN';
    case ReviewVerdict.Unsure:
      return '?';
  }
}

function toCsv(rows: QueueRow[]): string {
  if (rows.length === 0) return '';
  const headers = [
    'contentHash',
    'version',
    'label',
    'scanner',
    'entityType',
    'labelValue',
    'modelVersion',
    'score',
    'threshold',
    'triggered',
    'occurrences',
    'firstSeenAt',
    'lastSeenAt',
    'durationMs',
    'workflowIds',
    'entityIds',
    'matchedText',
    'matchedPositivePrompt',
    'matchedNegativePrompt',
    'myVerdict',
    'anyVerdict',
  ] as const;
  const lines = [headers.join(',')];
  for (const r of rows) {
    const cells: (string | number | null)[] = [
      r.contentHash,
      r.version,
      r.label,
      r.scanner,
      r.entityType,
      r.labelValue,
      r.modelVersion,
      r.score,
      r.threshold,
      r.triggered,
      r.occurrences,
      r.firstSeenAt,
      r.lastSeenAt,
      r.durationMs,
      r.workflowIds.join('|'),
      r.entityIds.join('|'),
      r.matchedText.join('|'),
      r.matchedPositivePrompt.join('|'),
      r.matchedNegativePrompt.join('|'),
      r.myVerdict ?? '',
      r.anyVerdict ?? '',
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\n');
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default Page(ScannerAuditTablePage);
