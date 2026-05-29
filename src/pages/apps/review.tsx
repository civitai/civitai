import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconCode,
  IconExternalLink,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/review — Moderator review queue + history for App Blocks publish
 * requests.
 *
 * Three tabs:
 *  - Pending  — oldest-first FIFO queue; click into a row to approve/reject.
 *  - Approved — newest-first history with the mod's optional approval notes
 *               and the "View code in Forgejo" link. Read-only modal.
 *  - Rejected — newest-first history with the required rejection reason
 *               surfaced inline. Read-only modal.
 *
 * Active tab is mirrored to `?tab=approved|rejected` so a mod can deep-link
 * to a specific history view (e.g. when pasting into a Discord thread).
 *
 * v0 gate: requires `isModerator`. v1 (W11 audit) opens to reviewers
 * outside the civitai team behind RBAC.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!session.user.isModerator) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

type FileSummary = {
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  added: string[];
  removed: string[];
  changed: string[];
};

type UserProfile = { id: number; username: string | null; image: string | null };

type ReviewedRequestCommon = {
  id: string;
  appBlockId: string | null;
  slug: string;
  version: string;
  submittedAt: string | Date;
  bundleSizeBytes: string;
  bundleSha256: string;
  manifest: unknown;
  fileSummary: unknown;
  manifestDiffSummary: unknown;
  reviewRepoUrl: string;
  submittedBy: UserProfile;
};

type PendingRequest = ReviewedRequestCommon;

type ApprovedRequest = ReviewedRequestCommon & {
  reviewedAt: string | Date | null;
  approvalNotes: string | null;
  reviewedBy: UserProfile | null;
};

type RejectedRequest = ReviewedRequestCommon & {
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  reviewedBy: UserProfile | null;
};

type AnyRequest = PendingRequest | ApprovedRequest | RejectedRequest;

type TabValue = 'pending' | 'approved' | 'rejected';

function isTabValue(v: unknown): v is TabValue {
  return v === 'pending' || v === 'approved' || v === 'rejected';
}

function formatBytes(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

export default function ReviewQueuePage() {
  const features = useFeatureFlags();
  const router = useRouter();

  // Sync active tab with `?tab=` so deep-links land on the right view. Use
  // shallow routing so the page query doesn't re-trigger getServerSideProps.
  const tab: TabValue = useMemo(() => {
    const qt = router.query.tab;
    if (typeof qt === 'string' && isTabValue(qt)) return qt;
    return 'pending';
  }, [router.query.tab]);

  const setTab = (next: TabValue) => {
    void router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: next } },
      undefined,
      { shallow: true }
    );
  };

  const [selected, setSelected] = useState<{
    request: AnyRequest;
    mode: TabValue;
  } | null>(null);

  if (!features?.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="App publish-request queue — Civitai" deIndex />
      <Container size="xl" py="xl">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>App publish-request queue</Title>
            <Text c="dimmed" size="sm">
              Moderator review for App Blocks. Pending queue is oldest-first;
              history tabs are newest-first.
            </Text>
          </Stack>

          <Tabs
            value={tab}
            onChange={(v) => {
              if (isTabValue(v)) setTab(v);
            }}
            keepMounted={false}
          >
            <Tabs.List>
              <Tabs.Tab value="pending" leftSection={<IconClock size={14} />}>
                Pending
              </Tabs.Tab>
              <Tabs.Tab value="approved" leftSection={<IconCheck size={14} />}>
                Approved
              </Tabs.Tab>
              <Tabs.Tab value="rejected" leftSection={<IconX size={14} />}>
                Rejected
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="pending" pt="md">
              <PendingTab
                onSelect={(r) => setSelected({ request: r, mode: 'pending' })}
              />
            </Tabs.Panel>

            <Tabs.Panel value="approved" pt="md">
              <ApprovedTab onSelect={(r) => setSelected({ request: r, mode: 'approved' })} />
            </Tabs.Panel>

            <Tabs.Panel value="rejected" pt="md">
              <RejectedTab onSelect={(r) => setSelected({ request: r, mode: 'rejected' })} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>

      <ReviewModal
        selection={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pending tab — original FIFO queue with approve/reject modal.
// ---------------------------------------------------------------------------

function PendingTab({ onSelect }: { onSelect: (r: PendingRequest) => void }) {
  const features = useFeatureFlags();
  const queue = trpc.blocks.listPendingRequests.useQuery(
    { limit: 50 },
    { enabled: !!features?.appBlocks }
  );

  const items = (queue.data?.items ?? []) as PendingRequest[];

  // The modal invalidates listPendingRequests via trpc.useUtils() on
  // approve/reject success, which forces this query to refetch
  // automatically — no prop-drilled onActioned callback needed.

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {queue.isLoading ? 'Loading…' : `${items.length} pending.`}
      </Text>

      {queue.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {queue.error.message}
        </Alert>
      )}

      {!queue.isLoading && items.length === 0 && (
        <Card withBorder p="lg">
          <Group gap="xs">
            <IconCheck color="var(--mantine-color-green-6)" size={20} />
            <Text>Queue is empty. Nothing waiting for review.</Text>
          </Group>
        </Card>
      )}

      {items.length > 0 && (
        <Card withBorder p={0}>
          <Table verticalSpacing="md" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Submitter</Table.Th>
                <Table.Th>Submitted</Table.Th>
                <Table.Th>Bundle</Table.Th>
                <Table.Th>Changes</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((r) => {
                const fs = (r.fileSummary ?? {}) as FileSummary;
                const mds = (r.manifestDiffSummary ?? {}) as ManifestDiffSummary;
                const isFirst = mds.kind === 'first-version';
                return (
                  <Table.Tr key={r.id} style={{ cursor: 'pointer' }}>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Group gap={6}>
                        <Code>{r.slug}</Code>
                        {isFirst && (
                          <Badge color="violet" size="xs">
                            first version
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Code>{r.version}</Code>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      {r.submittedBy.username ?? `#${r.submittedBy.id}`}
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Group gap={4}>
                        <IconClock size={14} />
                        <Text size="xs">{formatDate(r.submittedAt)}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Text size="xs" c="dimmed">
                        {formatBytes(r.bundleSizeBytes)} ·{' '}
                        {fs.files?.length ?? 0} files
                      </Text>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Group gap={6}>
                        {(fs.added?.length ?? 0) > 0 && (
                          <Badge color="green" size="xs">
                            +{fs.added.length}
                          </Badge>
                        )}
                        {(fs.changed?.length ?? 0) > 0 && (
                          <Badge color="yellow" size="xs">
                            ~{fs.changed.length}
                          </Badge>
                        )}
                        {(fs.removed?.length ?? 0) > 0 && (
                          <Badge color="red" size="xs">
                            −{fs.removed.length}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => onSelect(r)}
                        rightSection={<IconExternalLink size={12} />}
                      >
                        Review
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Approved tab — cursor-paginated history with inline approval notes.
// ---------------------------------------------------------------------------

function ApprovedTab({ onSelect }: { onSelect: (r: ApprovedRequest) => void }) {
  return (
    <HistoryTab
      kind="approved"
      onSelect={(r) => onSelect(r as ApprovedRequest)}
      emptyLabel="No approved publish requests yet."
    />
  );
}

// ---------------------------------------------------------------------------
// Rejected tab — cursor-paginated history with inline rejection reason.
// ---------------------------------------------------------------------------

function RejectedTab({ onSelect }: { onSelect: (r: RejectedRequest) => void }) {
  return (
    <HistoryTab
      kind="rejected"
      onSelect={(r) => onSelect(r as RejectedRequest)}
      emptyLabel="No rejected publish requests yet."
    />
  );
}

// ---------------------------------------------------------------------------
// Shared history tab — drives both approved + rejected. Differs only by the
// tRPC proc it calls and the inline mod-note column it renders.
// ---------------------------------------------------------------------------

function HistoryTab({
  kind,
  onSelect,
  emptyLabel,
}: {
  kind: 'approved' | 'rejected';
  onSelect: (r: ApprovedRequest | RejectedRequest) => void;
  emptyLabel: string;
}) {
  const features = useFeatureFlags();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<Array<ApprovedRequest | RejectedRequest>>([]);

  // Reset accumulated state when switching between tabs (kind doesn't
  // change in practice — each HistoryTab instance is per-kind — but if a
  // mod reloads the page on a different tab we start fresh).
  // Both procs share the listPendingRequestsSchema shape so the input
  // types are interchangeable.
  const approvedQuery = trpc.blocks.listApprovedRequests.useQuery(
    { limit: 25, cursor },
    { enabled: !!features?.appBlocks && kind === 'approved' }
  );
  const rejectedQuery = trpc.blocks.listRejectedRequests.useQuery(
    { limit: 25, cursor },
    { enabled: !!features?.appBlocks && kind === 'rejected' }
  );
  const query = kind === 'approved' ? approvedQuery : rejectedQuery;

  const page = (query.data?.items ?? []) as Array<ApprovedRequest | RejectedRequest>;

  // Merge each page result into the accumulated list. Dedupe by id in case
  // the user clicks Load more multiple times before the previous fetch
  // settled (defensive — react-query usually serializes these).
  const merged = useMemo(() => {
    if (!cursor) return page;
    const seen = new Set(accumulated.map((r) => r.id));
    return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
  }, [accumulated, page, cursor]);

  const onLoadMore = () => {
    // Snapshot the current page before advancing the cursor so the next
    // useQuery call starts a new fetch.
    setAccumulated(merged);
    const next = query.data?.nextCursor ?? undefined;
    if (next) setCursor(next);
  };

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {query.isLoading ? 'Loading…' : `${merged.length} shown.`}
      </Text>

      {query.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {query.error.message}
        </Alert>
      )}

      {!query.isLoading && merged.length === 0 && (
        <Card withBorder p="lg">
          <Group gap="xs">
            <IconCheck color="var(--mantine-color-gray-6)" size={20} />
            <Text>{emptyLabel}</Text>
          </Group>
        </Card>
      )}

      {merged.length > 0 && (
        <Card withBorder p={0}>
          <Table verticalSpacing="md" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Submitter</Table.Th>
                <Table.Th>{kind === 'approved' ? 'Approved by' : 'Rejected by'}</Table.Th>
                <Table.Th>Reviewed</Table.Th>
                <Table.Th>{kind === 'approved' ? 'Notes' : 'Reason'}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {merged.map((r) => {
                const isApproved = kind === 'approved';
                const approved = r as ApprovedRequest;
                const rejected = r as RejectedRequest;
                const note = isApproved ? approved.approvalNotes : rejected.rejectionReason;
                return (
                  <Table.Tr key={r.id} style={{ cursor: 'pointer' }}>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Code>{r.slug}</Code>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Code>{r.version}</Code>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      {r.submittedBy.username ?? `#${r.submittedBy.id}`}
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      {r.reviewedBy
                        ? r.reviewedBy.username
                          ? `@${r.reviewedBy.username}`
                          : `#${r.reviewedBy.id}`
                        : '—'}
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <Group gap={4}>
                        <IconClock size={14} />
                        <Text size="xs">{formatDate(r.reviewedAt)}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td onClick={() => onSelect(r)}>
                      <HistoryNoteCell note={note} />
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => onSelect(r)}
                        rightSection={<IconExternalLink size={12} />}
                      >
                        View
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {query.data?.nextCursor && !query.isFetching && (
        <Group justify="center">
          <Button variant="default" onClick={onLoadMore}>
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/**
 * Inline mod-note cell. Notes are usually one line; collapse anything
 * over ~120 chars behind a Show more toggle so the table rows don't
 * stretch unboundedly.
 */
function HistoryNoteCell({ note }: { note: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!note) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  const long = note.length > 120;
  const shown = expanded || !long ? note : `${note.slice(0, 120).trimEnd()}…`;
  return (
    <Stack gap={2} maw={360}>
      <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {shown}
      </Text>
      {long && (
        <Text
          component="button"
          type="button"
          size="xs"
          c="blue"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Text>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Review modal — pending requests get the interactive approve/reject UI;
// history requests get a read-only view with the mod feedback surfaced
// prominently.
// ---------------------------------------------------------------------------

function ReviewModal({
  selection,
  onClose,
}: {
  selection: { request: AnyRequest; mode: TabValue } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [approvalNotes, setApprovalNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [actionMode, setActionMode] = useState<'view' | 'reject'>('view');

  const approveMut = trpc.blocks.approveRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Approved ${selection?.request.slug} v${selection?.request.version}. Build started.`,
      });
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listApprovedRequests.invalidate();
      onClose();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Approve failed',
        error: new Error(e.message),
      });
    },
  });
  const rejectMut = trpc.blocks.rejectRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Rejected ${selection?.request.slug} v${selection?.request.version}.`,
      });
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listRejectedRequests.invalidate();
      onClose();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Reject failed',
        error: new Error(e.message),
      });
    },
  });

  if (!selection) return null;
  const { request, mode } = selection;
  const readOnly = mode !== 'pending';

  const manifest = request.manifest as Record<string, unknown>;
  const fs = (request.fileSummary ?? {}) as FileSummary;
  const mds = (request.manifestDiffSummary ?? {}) as ManifestDiffSummary;
  const busy = approveMut.isLoading || rejectMut.isLoading;

  const approved = mode === 'approved' ? (request as ApprovedRequest) : null;
  const rejected = mode === 'rejected' ? (request as RejectedRequest) : null;

  return (
    <Modal
      opened={!!selection}
      onClose={() => {
        if (busy) return;
        setApprovalNotes('');
        setRejectionReason('');
        setActionMode('view');
        onClose();
      }}
      title={
        <Group gap={6}>
          <Text fw={600}>{request.slug}</Text>
          <Code>{request.version}</Code>
          {mds.kind === 'first-version' && (
            <Badge color="violet" size="sm">
              first version
            </Badge>
          )}
          {mode === 'approved' && (
            <Badge color="green" size="sm">
              approved
            </Badge>
          )}
          {mode === 'rejected' && (
            <Badge color="red" size="sm">
              rejected
            </Badge>
          )}
        </Group>
      }
      size="xl"
      centered
    >
      <Stack gap="md">
        <Group gap="xs" align="flex-start">
          <Text size="xs" c="dimmed">
            Submitter:
          </Text>
          <Text size="xs">
            {request.submittedBy.username ?? `#${request.submittedBy.id}`}
          </Text>
          <Text size="xs" c="dimmed">
            ·
          </Text>
          <Text size="xs" c="dimmed">
            {formatDate(request.submittedAt)}
          </Text>
          <Text size="xs" c="dimmed">
            · {formatBytes(request.bundleSizeBytes)} · sha256:
          </Text>
          <Code style={{ fontSize: 10 }}>{request.bundleSha256.slice(0, 12)}…</Code>
        </Group>

        {(approved || rejected) && (
          <Card withBorder p="sm" bg={approved ? 'green.0' : 'red.0'}>
            <Stack gap={6}>
              <Group gap={6}>
                {approved ? (
                  <IconCheck size={16} color="var(--mantine-color-green-7)" />
                ) : (
                  <IconX size={16} color="var(--mantine-color-red-7)" />
                )}
                <Text size="sm" fw={600}>
                  {approved ? 'Approved by' : 'Rejected by'}{' '}
                  {(approved ?? rejected)?.reviewedBy
                    ? (approved ?? rejected)!.reviewedBy!.username
                      ? `@${(approved ?? rejected)!.reviewedBy!.username}`
                      : `#${(approved ?? rejected)!.reviewedBy!.id}`
                    : 'unknown'}
                </Text>
                <Text size="xs" c="dimmed">
                  · {formatDate((approved ?? rejected)!.reviewedAt)}
                </Text>
              </Group>
              {approved && approved.approvalNotes && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Approval notes
                  </Text>
                  <Text
                    size="sm"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {approved.approvalNotes}
                  </Text>
                </Stack>
              )}
              {approved && !approved.approvalNotes && (
                <Text size="xs" c="dimmed" fs="italic">
                  No approval notes were recorded.
                </Text>
              )}
              {rejected && rejected.rejectionReason && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Rejection reason
                  </Text>
                  <Text
                    size="sm"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {rejected.rejectionReason}
                  </Text>
                </Stack>
              )}
            </Stack>
          </Card>
        )}

        <Button
          component="a"
          href={request.reviewRepoUrl}
          target="_blank"
          rel="noopener"
          variant="default"
          leftSection={<IconCode size={14} />}
          rightSection={<IconExternalLink size={12} />}
        >
          View code in Forgejo
        </Button>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Files
          </Text>
          <Group gap={6}>
            <Text size="sm">{fs.files?.length ?? 0} total</Text>
            {(fs.added?.length ?? 0) > 0 && (
              <Badge color="green" variant="light">
                +{fs.added.length} added
              </Badge>
            )}
            {(fs.changed?.length ?? 0) > 0 && (
              <Badge color="yellow" variant="light">
                ~{fs.changed.length} changed
              </Badge>
            )}
            {(fs.removed?.length ?? 0) > 0 && (
              <Badge color="red" variant="light">
                −{fs.removed.length} removed
              </Badge>
            )}
          </Group>
          {mds.kind === 'update' && (
            <FileListPreview added={fs.added} removed={fs.removed} changed={fs.changed} />
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Manifest diff
          </Text>
          {mds.kind === 'first-version' ? (
            <Text size="xs" c="dimmed">
              First version — full manifest below.
            </Text>
          ) : (
            <ManifestDiffPreview diff={mds} />
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            New manifest
          </Text>
          <ScrollArea h={300} style={{ background: 'var(--mantine-color-gray-0)' }}>
            <Code block style={{ fontSize: 11, padding: 8 }}>
              {JSON.stringify(manifest, null, 2)}
            </Code>
          </ScrollArea>
        </Stack>

        {readOnly ? null : actionMode === 'reject' ? (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Rejection reason
            </Text>
            <Textarea
              autosize
              minRows={3}
              maxRows={10}
              placeholder="Explain what needs to change before this can be approved (≥10 chars, shown to the dev)."
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setActionMode('view')} disabled={busy}>
                Cancel
              </Button>
              <Button
                color="red"
                leftSection={<IconX size={14} />}
                onClick={() =>
                  rejectMut.mutate({
                    publishRequestId: request.id,
                    rejectionReason: rejectionReason.trim(),
                  })
                }
                disabled={busy || rejectionReason.trim().length < 10}
                loading={rejectMut.isLoading}
              >
                Reject
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Textarea
              label="Approval notes (optional)"
              autosize
              minRows={2}
              maxRows={6}
              placeholder="Optional notes attached to the approval record."
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              <Button
                color="red"
                variant="default"
                leftSection={<IconX size={14} />}
                onClick={() => setActionMode('reject')}
                disabled={busy}
              >
                Reject…
              </Button>
              <Button
                color="green"
                leftSection={<IconCheck size={14} />}
                onClick={() =>
                  approveMut.mutate({
                    publishRequestId: request.id,
                    approvalNotes: approvalNotes.trim() || undefined,
                  })
                }
                disabled={busy}
                loading={approveMut.isLoading}
              >
                Approve + build
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

function FileListPreview({
  added,
  removed,
  changed,
}: {
  added?: string[];
  removed?: string[];
  changed?: string[];
}) {
  const lines: Array<{ sigil: '+' | '~' | '-'; path: string; color: string }> = [];
  for (const p of added ?? []) lines.push({ sigil: '+', path: p, color: 'green' });
  for (const p of changed ?? []) lines.push({ sigil: '~', path: p, color: 'yellow' });
  for (const p of removed ?? []) lines.push({ sigil: '-', path: p, color: 'red' });
  if (lines.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No file-level changes.
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={180} style={{ background: 'var(--mantine-color-gray-0)' }}>
      <Stack gap={2} p={6}>
        {lines.map((l) => (
          <Group key={`${l.sigil}-${l.path}`} gap={6} wrap="nowrap">
            <Text size="xs" c={l.color} fw={700} style={{ width: 12 }}>
              {l.sigil}
            </Text>
            <Code style={{ fontSize: 11 }}>{l.path}</Code>
          </Group>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

function ManifestDiffPreview({
  diff,
}: {
  diff: { added: string[]; removed: string[]; changed: Array<{ field: string; from: unknown; to: unknown }> };
}) {
  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  ) {
    return (
      <Text size="xs" c="dimmed">
        No manifest changes (bundle resubmit with code-only diff).
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={260} style={{ background: 'var(--mantine-color-gray-0)' }}>
      <Stack gap={6} p={8}>
        {diff.added.map((field) => (
          <Group key={`+${field}`} gap={6}>
            <Text size="xs" c="green" fw={700}>
              +
            </Text>
            <Code style={{ fontSize: 11 }}>{field}</Code>
            <Text size="xs" c="dimmed">
              added
            </Text>
          </Group>
        ))}
        {diff.removed.map((field) => (
          <Group key={`-${field}`} gap={6}>
            <Text size="xs" c="red" fw={700}>
              −
            </Text>
            <Code style={{ fontSize: 11 }}>{field}</Code>
            <Text size="xs" c="dimmed">
              removed
            </Text>
          </Group>
        ))}
        {diff.changed.map((change) => (
          <Stack key={`~${change.field}`} gap={2}>
            <Group gap={6}>
              <Text size="xs" c="yellow" fw={700}>
                ~
              </Text>
              <Code style={{ fontSize: 11 }}>{change.field}</Code>
              <Text size="xs" c="dimmed">
                changed
              </Text>
            </Group>
            <Group gap={8} pl={18} align="flex-start">
              <Text size="xs" c="dimmed" style={{ minWidth: 32 }}>
                from
              </Text>
              <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(change.from)}
              </Code>
            </Group>
            <Group gap={8} pl={18} align="flex-start">
              <Text size="xs" c="dimmed" style={{ minWidth: 32 }}>
                to
              </Text>
              <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(change.to)}
              </Code>
            </Group>
          </Stack>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}
