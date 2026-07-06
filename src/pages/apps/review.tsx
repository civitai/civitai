import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconAdjustmentsAlt,
  IconCheck,
  IconClock,
  IconCode,
  IconExternalLink,
  IconKey,
  IconLayoutGrid,
  IconShieldLock,
  IconWindow,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { MouseEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { OffsiteReviewQueue } from '~/components/Apps/OffsiteReviewQueue';
import { pickReviewIframeSrc } from '~/components/Apps/reviewIframeSrc';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  SCOPE_DESCRIPTIONS,
  SLOT_DESCRIPTIONS,
} from '~/server/services/blocks/scope-descriptions.constants';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
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
    if (!isAppReviewer(session.user)) {
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
  // PUSH-ORIGINATED requests (git-push, empty bundle) have no review-org
  // snapshot — this links the mod to the canonical repo at the exact pushed sha.
  pushCommitUrl?: string | null;
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

// Compact relative age ("just now" / "5m" / "2h" / "3d") for the active-preview
// panel — the exact timestamp isn't useful there, freshness is.
function formatAge(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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
      <AppsPageLayout
        size="xl"
        title="App publish-request queue"
        subtitle="Moderator review for Apps. Pending queue is oldest-first; history tabs are newest-first."
      >
        <ActivePreviewsPanel />

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
            {/* On-site (App Block) queue — deep code review (byte-unchanged). */}
            <PendingTab
              onSelect={(r) => setSelected({ request: r, mode: 'pending' })}
            />
            {/* Off-site (external-link) queue — lighter content-only review (W13
                P3a). Kind-aware: its own table + modal + approve/reject procs. */}
            <OffsiteReviewQueue />
          </Tabs.Panel>

          <Tabs.Panel value="approved" pt="md">
            <ApprovedTab onSelect={(r) => setSelected({ request: r, mode: 'approved' })} />
          </Tabs.Panel>

          <Tabs.Panel value="rejected" pt="md">
            <RejectedTab onSelect={(r) => setSelected({ request: r, mode: 'rejected' })} />
          </Tabs.Panel>
        </Tabs>
      </AppsPageLayout>

      <ReviewModal
        selection={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// MOD REVIEW SANDBOX — global "Active previews (N / cap)" panel. Review previews
// are capped globally across all mods (each holds a review Deployment + Service
// + IngressRoute), so this surfaces every active preview + a per-row Tear down
// so a mod can free a slot. Polls every 30s so the count stays fresh. Dark
// behind the same mod-only review-sandbox flag as the per-request panel: when
// off, listActivePreviews throws UNAUTHORIZED and this renders nothing.
// ---------------------------------------------------------------------------

function ActivePreviewsPanel() {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();

  const query = trpc.blocks.listActivePreviews.useQuery(undefined, {
    enabled: !!features?.appBlocks,
    retry: false,
    // Poll every 30s to keep the count fresh WHILE it's working, but stop once the
    // query errors — when the review-sandbox flag is off (appBlocks on, sandbox
    // flag off) the server throws UNAUTHORIZED, and a fixed interval would re-fire
    // that guaranteed-dead request forever. (react-query v5: the callback gets the
    // Query; teardown mutations still invalidate → refetch, so a resume path exists.)
    refetchInterval: (q) => (q.state.error ? false : 30000),
  });

  const teardownMut = trpc.blocks.teardownPreview.useMutation({
    onSuccess: async (_res, vars) => {
      showSuccessNotification({ message: 'Review preview torn down.' });
      await Promise.all([
        utils.blocks.listActivePreviews.invalidate(),
        utils.blocks.getReviewStatus.invalidate({ publishRequestId: vars.publishRequestId }),
      ]);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Could not tear down preview', error: new Error(e.message) });
    },
  });

  // Flag off / not enabled (query errors) or nothing active → render nothing so
  // the panel stays unobtrusive when the sandbox isn't in use.
  const cap = query.data?.cap ?? 0;
  const active = query.data?.active ?? [];
  if (query.error || active.length === 0) return null;

  const atCap = cap > 0 && active.length >= cap;

  return (
    <Card withBorder p="md" mb="md">
      <Group gap={6} mb="xs">
        <IconWindow size={16} />
        <Text size="sm" fw={600}>
          Active previews
        </Text>
        <Badge size="sm" variant="light" color={atCap ? 'red' : 'blue'}>
          {active.length} / {cap}
        </Badge>
        {atCap && (
          <Text size="xs" c="red">
            Cap reached — tear one down to start another.
          </Text>
        )}
      </Group>
      <Table verticalSpacing="xs" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Age</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {active.map((p) => (
            <Table.Tr key={p.publishRequestId}>
              <Table.Td>
                <Code>{p.slug}</Code>
              </Table.Td>
              <Table.Td>
                <Code>{p.version}</Code>
              </Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={p.state === 'preview-live' ? 'green' : 'blue'}
                >
                  {p.state.replace('preview-', '')}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {formatAge(p.updatedAt)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  leftSection={<IconX size={12} />}
                  loading={
                    teardownMut.isPending &&
                    teardownMut.variables?.publishRequestId === p.publishRequestId
                  }
                  onClick={() => teardownMut.mutate({ publishRequestId: p.publishRequestId })}
                >
                  Tear down
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
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
  const busy = approveMut.isPending || rejectMut.isPending;

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
          <Alert
            color={approved ? 'green' : 'red'}
            variant="light"
            icon={approved ? <IconCheck size={16} /> : <IconX size={16} />}
            title={
              <Group gap={6}>
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
            }
          >
            {approved && approved.approvalNotes && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  Approval notes
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
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
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {rejected.rejectionReason}
                </Text>
              </Stack>
            )}
          </Alert>
        )}

        <Button
          component="a"
          href={request.pushCommitUrl ?? request.reviewRepoUrl}
          target="_blank"
          rel="noopener"
          variant="default"
          leftSection={<IconCode size={14} />}
          rightSection={<IconExternalLink size={12} />}
        >
          {request.pushCommitUrl
            ? 'View code in Forgejo (git push) ↗ commit'
            : 'View code in Forgejo'}
        </Button>

        {/* MOD REVIEW SANDBOX (#2831) — run the PENDING version in a temporary,
            mod-gated preview before approving. Pending requests only; dark
            unless the mod-only review-sandbox flag is enabled. */}
        {mode === 'pending' && <ReviewPreviewPanel publishRequestId={request.id} slug={request.slug} />}

        {/* F-E E5 — publisher screenshot gallery review. Publisher-supplied
            images are an abuse vector → the mod sees them (here, derived from
            the submitted bundle) before approving. Renders for every mode so an
            approved app's screenshots can be re-checked too. */}
        <ScreenshotsReviewPanel publishRequestId={request.id} />

        {/* F-E E4 curation — marketplace metadata (category / featured / order).
            Only for an APPROVED request that has a linked app_block: featuring
            is approved-only, and the meta lives on the app_block row. */}
        {mode === 'approved' && request.appBlockId && (
          <CurationPanel key={request.appBlockId} appBlockId={request.appBlockId} />
        )}

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
          {/* Line-level code diff — lazy (only fetched when the mod toggles it
              open) so the modal stays light by default. Bounded server-side;
              binary / oversized / huge-diff files fall back to the Forgejo link
              above. */}
          <CodeDiffPanel
            publishRequestId={request.id}
            forgejoUrl={request.pushCommitUrl ?? request.reviewRepoUrl}
          />
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
            Manifest
          </Text>
          <ManifestView manifest={manifest} />
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
                loading={rejectMut.isPending}
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
                loading={approveMut.isPending}
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

// ---------------------------------------------------------------------------
// F-E E5 screenshot review panel — surfaces the publisher-supplied screenshots
// auto-discovered from the submitted bundle so the mod reviews them before
// approval (publisher images = abuse vector). Renders <img> from base64 data
// URLs returned by the mod-only blocks.getPublishRequestScreenshots query (the
// pending app has no public screenshot URL yet — it isn't approved).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MOD REVIEW SANDBOX (#2831) — run a PENDING version in a temporary, mod-gated
// preview before approving. The Preview button starts a review build via
// blocks.previewRequest, then polls blocks.getReviewStatus (preview-building →
// deploying → live | failed) and, once live, embeds the review host in an
// iframe + offers a deep-link. The whole feature is dark behind the mod-only
// `app-blocks-review-sandbox` flag — when it's off, previewRequest throws
// UNAUTHORIZED and the panel surfaces a "not enabled" message instead.
// ---------------------------------------------------------------------------

function ReviewPreviewPanel({
  publishRequestId,
  slug,
}: {
  publishRequestId: string;
  slug: string;
}) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();

  // Poll the review status. Enabled on mount (not gated on a client "started"
  // flag) so a preview already live on the row is picked up after a page reload
  // / modal re-open — getReviewStatus returns the PERSISTED deploy_state, so we
  // derive the button + live iframe from the server, not from ephemeral React
  // state (which reset to "Start preview" on reload). building/deploying poll
  // fast, live polls slow, none/failed do a single fetch then stop (see
  // refetchInterval).
  const statusQuery = trpc.blocks.getReviewStatus.useQuery(
    { publishRequestId },
    {
      enabled: !!features?.appBlocks,
      retry: false,
      refetchInterval: (query) => {
        // react-query v5: the callback receives the Query; the data is at
        // query.state.data (matches the my-submissions.tsx idiom).
        const s = query.state.data?.state;
        if (s === 'preview-building' || s === 'preview-deploying') return 3000;
        // Keep a SLOW poll alive while the preview is live — it detects
        // approve/reject/teardown state changes. getReviewStatus mints a fresh
        // `?mr=<token>` previewUrl (120s TTL) on every poll, but the IFRAME src is
        // DECOUPLED from the poll via pickReviewIframeSrc (see `stableIframeSrc`
        // below): the iframe keeps its src until the embedded token nears expiry,
        // then swaps ONCE — so the live preview doesn't hard-reload every minute
        // (which would wipe in-progress interaction). A 60s poll < 120s TTL still
        // guarantees a fresh token is always available when a swap is due.
        if (s === 'preview-live') return 60000;
        return false; // failed or none → stop polling
      },
    }
  );

  const previewMut = trpc.blocks.previewRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Review build started for ${slug}.` });
      await utils.blocks.getReviewStatus.invalidate({ publishRequestId });
    },
    onError: (e) => {
      showErrorNotification({ title: 'Could not start preview', error: new Error(e.message) });
    },
  });

  const teardownMut = trpc.blocks.teardownPreview.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Review preview torn down for ${slug}.` });
      // Clears the DB preview state → getReviewStatus returns state:null and the
      // panel reverts to "Start preview". Also refresh the global panel's count.
      await Promise.all([
        utils.blocks.getReviewStatus.invalidate({ publishRequestId }),
        utils.blocks.listActivePreviews.invalidate(),
      ]);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Could not tear down preview', error: new Error(e.message) });
    },
  });

  const state = statusQuery.data?.state ?? null;
  const detail = statusQuery.data?.detail;
  // Prefer the FRESH, mod-bound, short-TTL tokened URL (`?mr=<token>`) the server
  // mints on every poll when the preview is live — that token is the cross-origin
  // access bridge the `*.civit.ai` mod-gate forwardAuth verifies on the iframe's
  // entry document request. Read from the latest query data each render so the
  // iframe never mounts with an expired token. Fall back to the bare host URL
  // (e.g. while building) only for display.
  const url = statusQuery.data?.previewUrl ?? detail?.url;
  const inProgress = state === 'preview-building' || state === 'preview-deploying';
  const isLive = state === 'preview-live';
  const isFailed = state === 'preview-failed';

  // Stabilize the IFRAME src so it does NOT change on every poll. getReviewStatus
  // mints a fresh `?mr=<token>` previewUrl every 60s poll; binding the iframe
  // straight to `url` would hard-reload it each minute, wiping in-progress
  // interaction in the previewed block. pickReviewIframeSrc keeps the embedded
  // src until its token nears expiry (TTL 120s), then swaps once. The Open-host
  // button + the `url` display still use the freshest token. Held in a ref so the
  // chosen src survives re-renders; recomputed each render via the pure helper.
  const iframeSrcRef = useRef<string | undefined>(undefined);
  const stableIframeSrc = isLive
    ? pickReviewIframeSrc(iframeSrcRef.current, url, Date.now())
    : undefined;
  // Persist the choice so the next render compares against the embedded token,
  // not the latest poll's. Clear when the preview leaves the live state.
  iframeSrcRef.current = stableIframeSrc || undefined;

  return (
    <Stack gap={4}>
      <Group gap={6}>
        <IconWindow size={14} />
        <Text size="sm" fw={600}>
          Review preview
        </Text>
        {state && (
          <Badge
            size="sm"
            variant="light"
            color={isLive ? 'green' : isFailed ? 'red' : 'blue'}
          >
            {state.replace('preview-', '')}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        Run this pending version in a temporary, mod-only preview before approving.
        Torn down automatically when you approve or reject.
      </Text>

      <Group gap="xs">
        <Button
          size="xs"
          variant="light"
          leftSection={<IconWindow size={14} />}
          loading={previewMut.isPending}
          disabled={previewMut.isPending || inProgress}
          onClick={() => previewMut.mutate({ publishRequestId })}
        >
          {state ? 'Rebuild preview' : 'Start preview'}
        </Button>
        {isLive && url && (
          <Button
            size="xs"
            variant="default"
            component="a"
            href={url}
            target="_blank"
            rel="noopener"
            rightSection={<IconExternalLink size={12} />}
          >
            Open review host
          </Button>
        )}
        {state && (
          // Shown for every non-null preview state INCLUDING preview-failed:
          // teardownPreview clears any deploy_state that starts with `preview-`
          // back to null, so a FAILED preview can be dismissed to "Start preview"
          // (not just rebuilt). Label reflects that a failed row has nothing live
          // to tear down — it's a dismiss.
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconX size={12} />}
            loading={teardownMut.isPending}
            disabled={teardownMut.isPending}
            onClick={() => teardownMut.mutate({ publishRequestId })}
          >
            {isFailed ? 'Dismiss failed preview' : 'Tear down preview'}
          </Button>
        )}
      </Group>

      {inProgress && (
        <Text size="xs" c="dimmed">
          Building + deploying the review preview…
          {detail?.sha ? ` (sha ${detail.sha.slice(0, 12)})` : ''}
        </Text>
      )}
      {isFailed && (
        <Alert color="red" variant="light" icon={<IconX size={14} />}>
          {detail?.error ?? 'Review preview failed.'}
        </Alert>
      )}
      {isLive && stableIframeSrc && (
        <iframe
          title={`Review preview for ${slug}`}
          src={stableIframeSrc}
          // no-referrer: the `?mr=<token>` entry-token URL must NOT leak via the
          // `Referer` header to assets the previewed (untrusted) block loads.
          // (We deliberately do NOT bind the token to a publishRequestId: that
          // binding isn't statelessly verifiable at the mod-gate without a DB
          // lookup, which the stateless forwardAuth gate intentionally avoids.
          // Host + mod + short TTL + no-referrer is the chosen containment.)
          referrerPolicy="no-referrer"
          style={{
            width: '100%',
            height: 420,
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 6,
          }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      )}
      {statusQuery.error && (
        <Text size="xs" c="dimmed">
          {statusQuery.error.message}
        </Text>
      )}
    </Stack>
  );
}

function ScreenshotsReviewPanel({ publishRequestId }: { publishRequestId: string }) {
  const features = useFeatureFlags();
  const { data, isLoading, error } = trpc.blocks.getPublishRequestScreenshots.useQuery(
    { publishRequestId },
    { enabled: !!features?.appBlocks, retry: false }
  );
  const items = data?.items ?? [];

  return (
    <Stack gap={4}>
      <Group gap={6}>
        <IconLayoutGrid size={14} />
        <Text size="sm" fw={600}>
          Screenshots
        </Text>
        {!isLoading && !error && (
          <Badge size="sm" variant="light" color={items.length > 0 ? 'blue' : 'gray'}>
            {items.length}
          </Badge>
        )}
      </Group>
      {isLoading ? (
        <Text size="xs" c="dimmed">
          Loading screenshots from the submitted bundle…
        </Text>
      ) : error ? (
        <Text size="xs" c="red">
          Could not load screenshots: {error.message}
        </Text>
      ) : items.length === 0 ? (
        <Text size="xs" c="dimmed">
          This bundle includes no `screenshots/` directory.
        </Text>
      ) : (
        <>
          <Text size="xs" c="dimmed">
            Publisher-supplied images from the bundle — review before approving.
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            {items.map((shot) => (
              <Card key={shot.index} withBorder padding={0} radius="md" style={{ overflow: 'hidden' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shot.dataUrl}
                  alt={`Screenshot ${shot.index + 1}`}
                  loading="lazy"
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                />
              </Card>
            ))}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// F-E E4 curation panel — mod controls to set the marketplace category +
// featured/order on an approved app_block (calls blocks.setMarketplaceMeta).
// Mod-only (the trPC procedures are moderatorProcedure-gated; the whole review
// page already requires isModerator).
// ---------------------------------------------------------------------------

const CATEGORY_SELECT_DATA = MARKETPLACE_CATEGORIES.map((c) => ({
  value: c,
  label: MARKETPLACE_CATEGORY_LABELS[c],
}));

function CurationPanel({ appBlockId }: { appBlockId: string }) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const metaQuery = trpc.blocks.getMarketplaceMeta.useQuery(
    { appBlockId },
    { enabled: !!features?.appBlocks }
  );

  // Local form state, seeded from the fetched meta. `dirty` becomes true once
  // the mod edits a field so Save is only enabled when there's a change.
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const [featured, setFeatured] = useState(false);
  const [featuredOrder, setFeaturedOrder] = useState<number | null>(null);
  const [seeded, setSeeded] = useState(false);

  const meta = metaQuery.data;
  // Seed once when the query first resolves (and re-seed if a different app's
  // meta arrives — keyed on appBlockId via the parent remount, but guard here
  // too in case the panel is reused).
  if (meta && !seeded) {
    setCategory(
      meta.category && (MARKETPLACE_CATEGORIES as readonly string[]).includes(meta.category)
        ? (meta.category as MarketplaceCategory)
        : null
    );
    setFeatured(meta.featured);
    setFeaturedOrder(meta.featuredOrder);
    setSeeded(true);
  }

  const saveMut = trpc.blocks.setMarketplaceMeta.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Marketplace metadata saved.' });
      await utils.blocks.getMarketplaceMeta.invalidate({ appBlockId });
      await utils.blocks.getFeaturedBlocks.invalidate();
      await utils.blocks.listAvailable.invalidate();
    },
    onError: (e) => {
      showErrorNotification({ title: 'Save failed', error: new Error(e.message) });
    },
  });

  const isApproved = meta?.status === 'approved';
  const busy = saveMut.isPending;

  const dirty =
    !!meta &&
    ((category ?? null) !== (meta.category ?? null) ||
      featured !== meta.featured ||
      (featuredOrder ?? null) !== (meta.featuredOrder ?? null));

  return (
    <Card withBorder p="sm">
      <Stack gap="sm">
        <Group gap={6}>
          <IconLayoutGrid size={14} />
          <Text size="sm" fw={600}>
            Marketplace curation
          </Text>
        </Group>

        {metaQuery.isLoading ? (
          <Text size="xs" c="dimmed">
            Loading…
          </Text>
        ) : metaQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            {metaQuery.error.message}
          </Alert>
        ) : (
          <>
            {!isApproved && (
              <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                This app is{' '}
                <Code>{meta?.status ?? 'unknown'}</Code> — only an approved app can be
                featured. Category/order can still be set.
              </Alert>
            )}
            <Select
              label="Category"
              data={CATEGORY_SELECT_DATA}
              value={category}
              onChange={(v) => setCategory((v as MarketplaceCategory) || null)}
              placeholder="No category"
              clearable
              disabled={busy}
              w={240}
            />
            <Switch
              label="Featured (staff pick rail)"
              checked={featured}
              onChange={(e) => setFeatured(e.currentTarget.checked)}
              disabled={busy || !isApproved}
            />
            <NumberInput
              label="Featured order (lower = earlier)"
              value={featuredOrder ?? ''}
              onChange={(v) =>
                setFeaturedOrder(typeof v === 'number' ? v : v === '' ? null : Number(v))
              }
              min={0}
              max={100000}
              allowDecimal={false}
              placeholder="unset"
              disabled={busy}
              w={240}
            />
            <Group justify="flex-end">
              <Button
                size="xs"
                leftSection={<IconCheck size={14} />}
                disabled={!dirty || busy}
                loading={busy}
                onClick={() =>
                  saveMut.mutate({
                    appBlockId,
                    category: category ?? null,
                    featured,
                    featuredOrder: featuredOrder ?? null,
                  })
                }
              >
                Save curation
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Card>
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

// ---------------------------------------------------------------------------
// Line-level code diff — expands the file-level summary with the actual unified
// line diff per changed/added text file. Lazy: the query only fires once the mod
// toggles "Show code diff" on, so the modal default stays light. Bounded
// server-side (text-only, byte/line/file caps); elided files render a "view in
// Forgejo" fallback rather than inlining unbounded content.
// ---------------------------------------------------------------------------

type FileLineDiff = {
  path: string;
  changeKind: 'added' | 'changed';
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  skipReason: 'binary' | 'too-large' | 'diff-too-large' | 'file-cap' | null;
  added: number;
  removed: number;
};

const SKIP_LABEL: Record<NonNullable<FileLineDiff['skipReason']>, string> = {
  binary: 'Binary file — view in Forgejo',
  'too-large': 'File too large to diff — view in Forgejo',
  'diff-too-large': 'Diff too large to display — view in Forgejo',
  'file-cap': 'Too many changed files — view this one in Forgejo',
};

function CodeDiffPanel({
  publishRequestId,
  forgejoUrl,
}: {
  publishRequestId: string;
  forgejoUrl: string;
}) {
  const features = useFeatureFlags();
  const [show, setShow] = useState(false);

  const { data, isLoading, error } = trpc.blocks.getPublishRequestDiff.useQuery(
    { publishRequestId },
    // Only fetch once toggled on (lazy). retry:false keeps a failed fetch from
    // hammering MinIO/Forgejo for a request with no diffable artifact.
    { enabled: !!features?.appBlocks && show, retry: false }
  );

  const files = (data?.files ?? []) as FileLineDiff[];

  return (
    <Stack gap={4}>
      <Group gap={8}>
        <Switch
          size="sm"
          label="Show code diff"
          checked={show}
          onChange={(e) => setShow(e.currentTarget.checked)}
        />
        {show && !isLoading && !error && (
          <Text size="xs" c="dimmed">
            {files.length} file{files.length === 1 ? '' : 's'} changed
            {data?.truncated ? ' (some elided — view in Forgejo)' : ''}
          </Text>
        )}
      </Group>

      {show &&
        (isLoading ? (
          <Text size="xs" c="dimmed">
            Computing line diff from the submitted bundle…
          </Text>
        ) : error ? (
          <Text size="xs" c="red">
            Could not load code diff: {error.message}
          </Text>
        ) : files.length === 0 ? (
          <Text size="xs" c="dimmed">
            No textual file changes to show.
          </Text>
        ) : (
          <Stack gap={6}>
            {files.map((f) => (
              <FileDiffEntry key={f.path} file={f} forgejoUrl={forgejoUrl} />
            ))}
          </Stack>
        ))}
    </Stack>
  );
}

function FileDiffEntry({ file, forgejoUrl }: { file: FileLineDiff; forgejoUrl: string }) {
  const [open, setOpen] = useState(false);
  const elided = file.skipReason !== null;

  return (
    <Card withBorder p={0}>
      <Group
        justify="space-between"
        wrap="nowrap"
        p={8}
        style={{ cursor: elided ? 'default' : 'pointer' }}
        onClick={() => {
          if (!elided) setOpen((v) => !v);
        }}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Badge
            size="xs"
            color={file.changeKind === 'added' ? 'green' : 'yellow'}
            variant="light"
          >
            {file.changeKind === 'added' ? 'added' : 'changed'}
          </Badge>
          <Code style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {file.path}
          </Code>
        </Group>
        <Group gap={6} wrap="nowrap">
          {!elided && file.added > 0 && (
            <Text size="xs" c="green" fw={700}>
              +{file.added}
            </Text>
          )}
          {!elided && file.removed > 0 && (
            <Text size="xs" c="red" fw={700}>
              −{file.removed}
            </Text>
          )}
          {elided && (
            <Text size="xs" c="dimmed" fs="italic">
              {SKIP_LABEL[file.skipReason!]}
            </Text>
          )}
          {!elided && (
            <Text size="xs" c="blue">
              {open ? 'hide' : 'show'}
            </Text>
          )}
        </Group>
      </Group>

      {elided && (
        <Group p={8} pt={0}>
          <Button
            component="a"
            href={forgejoUrl}
            target="_blank"
            rel="noopener"
            size="compact-xs"
            variant="subtle"
            leftSection={<IconCode size={12} />}
            rightSection={<IconExternalLink size={10} />}
          >
            View in Forgejo
          </Button>
        </Group>
      )}

      {open && !elided && (
        <ScrollArea.Autosize mah={320} style={{ background: 'var(--mantine-color-gray-0)' }}>
          <Stack gap={0} p={6} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
            {file.hunks.length === 0 ? (
              <Text size="xs" c="dimmed">
                No textual change (whitespace/metadata only).
              </Text>
            ) : (
              file.hunks.map((h, hi) => <DiffHunkView key={hi} hunk={h} />)
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}

function DiffHunkView({
  hunk,
}: {
  hunk: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  };
}) {
  return (
    <>
      <Text size="xs" c="cyan" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
      </Text>
      {hunk.lines.map((line, i) => {
        const sigil = line[0];
        const color = sigil === '+' ? 'green' : sigil === '-' ? 'red' : undefined;
        const bg =
          sigil === '+'
            ? 'var(--mantine-color-green-0)'
            : sigil === '-'
            ? 'var(--mantine-color-red-0)'
            : undefined;
        return (
          <Text
            key={i}
            size="xs"
            c={color}
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              background: bg,
              paddingLeft: 4,
            }}
          >
            {line.length === 0 ? ' ' : line}
          </Text>
        );
      })}
    </>
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

// ---------------------------------------------------------------------------
// Structured manifest renderer (replaces the raw JSON dump)
// ---------------------------------------------------------------------------

/** Manifest top-level keys this renderer handles inline. Anything else falls
 * into the "Other fields" accordion as raw JSON so reviewers can still see
 * unexpected payloads. */
const HANDLED_MANIFEST_KEYS = new Set([
  '$schema',
  'appId',
  'blockId',
  'version',
  'name',
  'description',
  'type',
  'minApiVersion',
  'contentRating',
  'renderMode',
  'trustTier',
  'scopes',
  'targets',
  'iframe',
  'settings',
]);

function ManifestView({ manifest }: { manifest: Record<string, unknown> }) {
  const otherKeys = useMemo(
    () =>
      Object.keys(manifest)
        .filter((k) => !HANDLED_MANIFEST_KEYS.has(k))
        .sort(),
    [manifest]
  );

  return (
    <Stack gap="sm">
      <ManifestIdentity manifest={manifest} />
      <ManifestScopes manifest={manifest} />
      <ManifestTargets manifest={manifest} />
      <ManifestIframe manifest={manifest} />
      <ManifestSettings manifest={manifest} />
      {otherKeys.length > 0 && (
        <Accordion variant="contained" multiple={false}>
          <Accordion.Item value="other">
            <Accordion.Control>
              <Text size="sm" fw={500}>
                Other manifest fields ({otherKeys.length})
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <ScrollArea h={200}>
                <Code block style={{ fontSize: 11, padding: 8 }}>
                  {JSON.stringify(
                    Object.fromEntries(otherKeys.map((k) => [k, manifest[k]])),
                    null,
                    2
                  )}
                </Code>
              </ScrollArea>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Stack>
  );
}

function ManifestIdentity({ manifest }: { manifest: Record<string, unknown> }) {
  const name = typeof manifest.name === 'string' ? manifest.name : null;
  const description =
    typeof manifest.description === 'string' ? manifest.description : null;
  const blockId = typeof manifest.blockId === 'string' ? manifest.blockId : null;
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  const contentRating =
    typeof manifest.contentRating === 'string' ? manifest.contentRating : null;
  const trustTier = typeof manifest.trustTier === 'string' ? manifest.trustTier : null;
  const renderMode = typeof manifest.renderMode === 'string' ? manifest.renderMode : null;

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            {name && (
              <Text size="md" fw={600}>
                {name}
              </Text>
            )}
            <Group gap={6}>
              {blockId && <Code>{blockId}</Code>}
              {version && (
                <Badge color="gray" variant="light">
                  v{version}
                </Badge>
              )}
            </Group>
          </Stack>
          <Group gap={6}>
            {contentRating && (
              <Tooltip label="Content rating">
                <Badge color={ratingColor(contentRating)} variant="filled">
                  {contentRating}
                </Badge>
              </Tooltip>
            )}
            {trustTier && (
              <Tooltip label="Trust tier">
                <Badge color={trustColor(trustTier)} variant="light">
                  {trustTier}
                </Badge>
              </Tooltip>
            )}
            {renderMode && (
              <Tooltip label="Render mode">
                <Badge color="gray" variant="outline">
                  {renderMode}
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Group>
        {description && (
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
            {description}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function ratingColor(rating: string): string {
  switch (rating.toLowerCase()) {
    case 'g':
      return 'green';
    case 'pg':
      return 'lime';
    case 'pg13':
      return 'yellow';
    case 'r':
      return 'orange';
    case 'x':
    case 'xxx':
      return 'red';
    default:
      return 'gray';
  }
}

function trustColor(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'internal':
      return 'blue';
    case 'verified':
      return 'green';
    case 'unverified':
      return 'orange';
    default:
      return 'gray';
  }
}

function ManifestScopes({ manifest }: { manifest: Record<string, unknown> }) {
  const scopes = Array.isArray(manifest.scopes)
    ? (manifest.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6}>
          <IconKey size={14} />
          <Text size="sm" fw={600}>
            JWT scopes ({scopes.length})
          </Text>
        </Group>
        {scopes.length === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">
            No scopes requested — block can only consume host postMessage
            data, no scope-gated platform APIs.
          </Text>
        ) : (
          <Stack gap={4}>
            {scopes.map((s) => {
              const desc = SCOPE_DESCRIPTIONS[s];
              const known = !!desc;
              return (
                <Group key={s} gap={8} align="flex-start" wrap="nowrap">
                  <Badge
                    variant={known ? 'light' : 'outline'}
                    color={known ? 'blue' : 'red'}
                    style={{ fontFamily: 'ui-monospace, monospace' }}
                  >
                    {s}
                  </Badge>
                  <Text size="xs" c={known ? 'dimmed' : 'red'}>
                    {desc ?? 'Unknown scope — would fail at token issuance.'}
                  </Text>
                </Group>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function ManifestTargets({ manifest }: { manifest: Record<string, unknown> }) {
  const targets = Array.isArray(manifest.targets)
    ? (manifest.targets as Array<Record<string, unknown>>)
    : [];
  if (targets.length === 0) return null;
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6}>
          <IconLayoutGrid size={14} />
          <Text size="sm" fw={600}>
            Slot targets ({targets.length})
          </Text>
        </Group>
        <Stack gap={6}>
          {targets.map((t, i) => {
            const slotId = typeof t.slotId === 'string' ? t.slotId : '?';
            const priority = typeof t.priority === 'number' ? t.priority : null;
            const requiredContext = Array.isArray(t.requiredContext)
              ? (t.requiredContext as unknown[]).filter(
                  (c): c is string => typeof c === 'string'
                )
              : [];
            const slotDesc = SLOT_DESCRIPTIONS[slotId];
            return (
              <Stack key={i} gap={2}>
                <Group gap={6}>
                  <Code>{slotId}</Code>
                  {priority !== null && (
                    <Badge size="xs" color="gray" variant="light">
                      priority {priority}
                    </Badge>
                  )}
                </Group>
                {slotDesc && (
                  <Text size="xs" c="dimmed" pl={4}>
                    {slotDesc}
                  </Text>
                )}
                {requiredContext.length > 0 && (
                  <Group gap={4} pl={4}>
                    <Text size="xs" c="dimmed">
                      requires:
                    </Text>
                    {requiredContext.map((c) => (
                      <Code key={c} style={{ fontSize: 10 }}>
                        {c}
                      </Code>
                    ))}
                  </Group>
                )}
              </Stack>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}

function ManifestIframe({ manifest }: { manifest: Record<string, unknown> }) {
  const iframe =
    manifest.iframe && typeof manifest.iframe === 'object'
      ? (manifest.iframe as Record<string, unknown>)
      : null;
  if (!iframe) return null;
  const src = typeof iframe.src === 'string' ? iframe.src : null;
  const sandbox = typeof iframe.sandbox === 'string' ? iframe.sandbox : null;
  const minHeight = typeof iframe.minHeight === 'number' ? iframe.minHeight : null;
  const maxHeight = typeof iframe.maxHeight === 'number' ? iframe.maxHeight : null;
  const resizable = typeof iframe.resizable === 'boolean' ? iframe.resizable : null;

  const sandboxFlags = sandbox ? sandbox.split(/\s+/).filter(Boolean) : [];

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6}>
          <IconWindow size={14} />
          <Text size="sm" fw={600}>
            Iframe
          </Text>
        </Group>
        {src && (
          <Group gap={6} align="baseline">
            <Text size="xs" c="dimmed" style={{ minWidth: 60 }}>
              src
            </Text>
            <a href={src} target="_blank" rel="noopener" style={{ fontSize: 12 }}>
              {src}
            </a>
          </Group>
        )}
        {sandboxFlags.length > 0 && (
          <Group gap={6} align="baseline">
            <Text size="xs" c="dimmed" style={{ minWidth: 60 }}>
              sandbox
            </Text>
            <Group gap={4}>
              {sandboxFlags.map((flag) => {
                const risky =
                  flag === 'allow-same-origin' ||
                  flag === 'allow-top-navigation' ||
                  flag === 'allow-popups-to-escape-sandbox';
                return (
                  <Tooltip
                    key={flag}
                    label={
                      risky
                        ? 'Higher-risk sandbox flag — review carefully.'
                        : 'Standard sandbox flag.'
                    }
                  >
                    <Badge
                      size="xs"
                      color={risky ? 'orange' : 'gray'}
                      variant="light"
                      leftSection={risky ? <IconShieldLock size={10} /> : undefined}
                    >
                      {flag}
                    </Badge>
                  </Tooltip>
                );
              })}
            </Group>
          </Group>
        )}
        {(minHeight !== null || maxHeight !== null || resizable !== null) && (
          <Group gap={12}>
            {minHeight !== null && (
              <Text size="xs">
                <Text component="span" size="xs" c="dimmed">
                  min height:
                </Text>{' '}
                {minHeight}px
              </Text>
            )}
            {maxHeight !== null && (
              <Text size="xs">
                <Text component="span" size="xs" c="dimmed">
                  max height:
                </Text>{' '}
                {maxHeight}px
              </Text>
            )}
            {resizable !== null && (
              <Text size="xs">
                <Text component="span" size="xs" c="dimmed">
                  resizable:
                </Text>{' '}
                {resizable ? 'yes' : 'no'}
              </Text>
            )}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function ManifestSettings({ manifest }: { manifest: Record<string, unknown> }) {
  const settings =
    manifest.settings && typeof manifest.settings === 'object'
      ? (manifest.settings as Record<string, unknown>)
      : null;
  const entries = settings ? Object.entries(settings) : [];
  if (entries.length === 0) return null;
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6}>
          <IconAdjustmentsAlt size={14} />
          <Text size="sm" fw={600}>
            Settings ({entries.length})
          </Text>
        </Group>
        <Stack gap={8}>
          {entries.map(([key, raw]) => {
            const def =
              raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            const type = typeof def.type === 'string' ? def.type : '?';
            const widget = typeof def.widget === 'string' ? def.widget : null;
            const label = typeof def.label === 'string' ? def.label : null;
            const description =
              typeof def.description === 'string' ? def.description : null;
            const scope = typeof def.scope === 'string' ? def.scope : null;
            const defaultVal = def.default;
            const min = typeof def.min === 'number' ? def.min : null;
            const max = typeof def.max === 'number' ? def.max : null;
            const requiresScope =
              typeof def.requires_scope === 'string' ? def.requires_scope : null;
            return (
              <Stack key={key} gap={2}>
                <Group gap={6} wrap="nowrap" align="baseline">
                  <Code style={{ fontSize: 11 }}>{key}</Code>
                  <Badge size="xs" variant="light">
                    {type}
                    {widget && widget !== type ? `/${widget}` : ''}
                  </Badge>
                  {scope && (
                    <Badge size="xs" color="gray" variant="outline">
                      {scope}
                    </Badge>
                  )}
                  {requiresScope && (
                    <Badge size="xs" color="blue" variant="outline">
                      needs {requiresScope}
                    </Badge>
                  )}
                </Group>
                {label && (
                  <Text size="xs" pl={4}>
                    {label}
                  </Text>
                )}
                {description && (
                  <Text size="xs" c="dimmed" pl={4}>
                    {description}
                  </Text>
                )}
                <Group gap={8} pl={4}>
                  {defaultVal !== undefined && (
                    <Text size="xs" c="dimmed">
                      default:{' '}
                      <Code style={{ fontSize: 10 }}>{JSON.stringify(defaultVal)}</Code>
                    </Text>
                  )}
                  {(min !== null || max !== null) && (
                    <Text size="xs" c="dimmed">
                      range: {min ?? '−∞'} – {max ?? '+∞'}
                    </Text>
                  )}
                </Group>
              </Stack>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}
