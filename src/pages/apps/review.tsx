import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Table,
  Tabs,
  Text,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconFlag,
  IconWindow,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppListingsModerationTable } from '~/components/Apps/AppListingsModerationTable';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
// `OffsiteReviewQueue` (the flat pending-only off-site list) is SUPERSEDED by the
// unified `AppListingsModerationTable` below (which covers pending too, via the
// per-row Review action). It stays exported for a one-line rollback: swap the
// `<AppListingsModerationTable />` in the Pending panel back to `<OffsiteReviewQueue />`.
import { OffsiteReportsQueue } from '~/components/Apps/OffsiteReviewQueue';
// The on-site (App Block) review modal + its request types and byte-formatters
// were EXTRACTED to `OnsiteReviewModal.tsx` (mirrors the #3154 diff-panel
// extraction) so the modal is importable into a browser test WITHOUT this page's
// `getServerSideProps`/`createServerSideProps` tRPC-server graph. This page mounts
// it identically to before.
import {
  OnsiteReviewModal,
  formatBytes,
  formatDate,
  type AnyRequest,
  type ApprovedRequest,
  type FileSummary,
  type ManifestDiffSummary,
  type PendingRequest,
  type RejectedRequest,
} from '~/components/Apps/OnsiteReviewModal';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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

// The request types (PendingRequest / ApprovedRequest / RejectedRequest /
// AnyRequest, FileSummary, ManifestDiffSummary) moved to `OnsiteReviewModal.tsx`
// alongside the modal and are imported above.

type TabValue = 'pending' | 'approved' | 'rejected' | 'reports';

function isTabValue(v: unknown): v is TabValue {
  return v === 'pending' || v === 'approved' || v === 'rejected' || v === 'reports';
}

// `formatBytes` + `formatDate` moved to `OnsiteReviewModal.tsx` (imported above).

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
            <Tabs.Tab value="reports" leftSection={<IconFlag size={14} />}>
              Reports
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="pending" pt="md">
            {/* On-site (App Block) queue — deep code review (byte-unchanged). The
                onsite iframe/preview review lives here and is KEPT as-is. */}
            <PendingTab
              onSelect={(r) => setSelected({ request: r, mode: 'pending' })}
            />
            {/* Unified moderator LISTINGS MANAGEMENT table (W13 post-approval mgmt,
                P2) — all statuses across both kinds, with per-row lifecycle actions.
                REPLACES the flat off-site pending list (`OffsiteReviewQueue`): a
                pending off-site row's Review action opens that same review modal, so
                the table now covers pending too while adding post-approval
                management (reset/hide/relist/claim/purge) that had no home. */}
            <AppListingsModerationTable />
          </Tabs.Panel>

          <Tabs.Panel value="approved" pt="md">
            <ApprovedTab onSelect={(r) => setSelected({ request: r, mode: 'approved' })} />
          </Tabs.Panel>

          <Tabs.Panel value="rejected" pt="md">
            <RejectedTab onSelect={(r) => setSelected({ request: r, mode: 'rejected' })} />
          </Tabs.Panel>

          <Tabs.Panel value="reports" pt="md">
            {/* Off-site listing REPORT queue + mod takedown actions (W13 P3b PR3).
                Dark + mod-only; read via appListings.listListingReports. */}
            <OffsiteReportsQueue />
          </Tabs.Panel>
        </Tabs>
      </AppsPageLayout>

      <OnsiteReviewModal
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

  // Flag off / not enabled or nothing active → render nothing so the panel stays
  // unobtrusive when the sandbox isn't in use. An AUTHZ error (sandbox flag off →
  // UNAUTHORIZED) is that intended silent case; a TRANSIENT error surfaces a retry
  // instead of silently disappearing.
  const cap = query.data?.cap ?? 0;
  const active = query.data?.active ?? [];
  if (!features?.appBlocks) return null;
  if (query.error) {
    if (isModAuthzError(query.error)) return null;
    return (
      <ModQueryError
        error={query.error}
        onRetry={() => query.refetch()}
        isRetrying={query.isFetching}
        title="Couldn’t load active previews"
        testId="apps-active-previews-error"
        mt="md"
      />
    );
  }
  if (active.length === 0) return null;

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
