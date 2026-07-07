import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconFlag,
  IconHistory,
  IconQuestionMark,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { getOffsiteReviewChecklist } from '~/components/Apps/offsiteReviewChecklist';
import { getReportReasonLabel } from '~/components/Apps/appListingReportView';
import {
  isDestructiveAction,
  listingStatusChip,
  moderationActionChip,
  reportActionLabel,
  reportRowActions,
  reportStatusChip,
  type ReportRowAction,
} from '~/components/Apps/appListingModerationView';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/review — the OFF-SITE (external-link) pending review section (W13 P3a).
 * Rendered kind-aware ALONGSIDE the existing on-site App Block queue (which is
 * byte-unchanged). An off-site row gets a LIGHTER, content-only review (no code /
 * bundle / manifest) driven by `getOffsiteReviewChecklist`, and Approve/Reject call
 * the off-site procs (`appListings.approveExternalRequest` /
 * `rejectExternalRequest`). Data is `appListings.listPendingRequests`
 * (moderatorProcedure); the whole /apps/review page already requires isModerator.
 */

type OffsiteUser = { id: number; username: string | null; image: string | null };

type OffsitePendingRow = {
  id: string;
  appListingId: string | null;
  slug: string;
  status: string;
  submittedAt: string | Date;
  changelog: string | null;
  appListing: {
    name: string | null;
    externalUrl: string | null;
    category: string | null;
    contentRating: string | null;
  } | null;
  submittedBy: OffsiteUser | null;
};

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

export function OffsiteReviewQueue() {
  const features = useFeatureFlags();
  const [selected, setSelected] = useState<OffsitePendingRow | null>(null);

  const queue = trpc.appListings.listPendingRequests.useQuery(
    { limit: 50 },
    { enabled: !!features?.appBlocks, retry: false }
  );

  // Flag off / not enabled → the query errors (moderatorProcedure); render nothing
  // so the section stays unobtrusive when off-site review isn't in use.
  if (queue.error) return null;

  const items = (queue.data?.items ?? []) as OffsitePendingRow[];

  return (
    <Stack gap="sm" mt="lg">
      <Divider
        label={
          <Group gap={6}>
            <IconExternalLink size={14} />
            <Text size="sm" fw={600}>
              External-link submissions
            </Text>
            <Badge size="sm" variant="light" color={items.length > 0 ? 'grape' : 'gray'}>
              {items.length}
            </Badge>
          </Group>
        }
        labelPosition="left"
      />
      <Text size="xs" c="dimmed">
        Off-site apps — a lighter, content-only review (no code / bundle). Approving requires an
        asset-complete draft (icon + cover + ≥1 screenshot).
      </Text>

      {queue.isLoading ? (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      ) : items.length === 0 ? (
        <Card withBorder p="md">
          <Group gap="xs">
            <IconCheck color="var(--mantine-color-green-6)" size={18} />
            <Text size="sm">No external-link submissions waiting for review.</Text>
          </Group>
        </Card>
      ) : (
        <Card withBorder p={0}>
          <Table verticalSpacing="md" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Link</Table.Th>
                <Table.Th>Submitter</Table.Th>
                <Table.Th>Submitted</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((r) => (
                <Table.Tr key={r.id} style={{ cursor: 'pointer' }}>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Group gap={6}>
                      <Code>{r.slug}</Code>
                    </Group>
                    {r.appListing?.name && (
                      <Text size="xs" c="dimmed">
                        {r.appListing.name}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Text size="xs" c="dimmed" lineClamp={1} style={{ maxWidth: 240 }}>
                      {r.appListing?.externalUrl ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Text size="xs">{r.submittedBy?.username ?? `#${r.submittedBy?.id ?? '?'}`}</Text>
                  </Table.Td>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Group gap={4}>
                      <IconClock size={14} />
                      <Text size="xs">{formatDate(r.submittedAt)}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => setSelected(r)}
                      rightSection={<IconExternalLink size={12} />}
                      data-testid={`apps-offsite-review-${r.slug}`}
                    >
                      Review
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <OffsiteReviewModal request={selected} onClose={() => setSelected(null)} />
    </Stack>
  );
}

function OffsiteReviewModal({
  request,
  onClose,
}: {
  request: OffsitePendingRow | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const features = useFeatureFlags();
  const [rejectionReason, setRejectionReason] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [actionMode, setActionMode] = useState<'view' | 'reject'>('view');

  // Asset presence for the content checklist (author/mod-gated; a mod passes the
  // author floor). Only enabled once a row with a draft listing is open.
  const assetsQuery = trpc.appListings.getAssets.useQuery(
    { listingId: request?.appListingId ?? '' },
    { enabled: !!features?.appBlocks && !!request?.appListingId, retry: false }
  );

  const approveMut = trpc.appListings.approveExternalRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Approved ${request?.slug}.` });
      await utils.appListings.listPendingRequests.invalidate();
      await utils.appListings.listApprovedRequests.invalidate();
      close();
    },
    onError: (e: { message: string }) => {
      showErrorNotification({ title: 'Approve failed', error: new Error(e.message) });
    },
  });
  const rejectMut = trpc.appListings.rejectExternalRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Rejected ${request?.slug}.` });
      await utils.appListings.listPendingRequests.invalidate();
      await utils.appListings.listRejectedRequests.invalidate();
      close();
    },
    onError: (e: { message: string }) => {
      showErrorNotification({ title: 'Reject failed', error: new Error(e.message) });
    },
  });

  const busy = approveMut.isPending || rejectMut.isPending;

  function close() {
    setRejectionReason('');
    setApprovalNotes('');
    setActionMode('view');
    onClose();
  }

  if (!request) return null;

  const screenshotCount = (assetsQuery.data?.screenshots ?? []).filter(
    (s: { imageId: number | null }) => s.imageId != null
  ).length;
  const hasIcon = assetsQuery.data?.iconId != null;
  const hasCover = assetsQuery.data?.coverId != null;

  const checklist = getOffsiteReviewChecklist({
    name: request.appListing?.name,
    externalUrl: request.appListing?.externalUrl,
    hasIcon,
    hasCover,
    screenshotCount,
    category: request.appListing?.category,
    description: null,
  });

  const assetsIncomplete = !assetsQuery.isLoading && (!hasIcon || !hasCover || screenshotCount < 1);

  return (
    <Modal
      opened={!!request}
      onClose={() => {
        if (busy) return;
        close();
      }}
      title={
        <Group gap={6}>
          <Text fw={600}>{request.slug}</Text>
          <Badge color="grape" size="sm" variant="light">
            external
          </Badge>
        </Group>
      }
      size="lg"
      centered
    >
      <Stack gap="md">
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Submitter:
          </Text>
          <Text size="xs">{request.submittedBy?.username ?? `#${request.submittedBy?.id ?? '?'}`}</Text>
          <Text size="xs" c="dimmed">
            · {formatDate(request.submittedAt)}
          </Text>
        </Group>

        <Card withBorder p="sm">
          <Stack gap={6}>
            {request.appListing?.name && (
              <Text size="md" fw={600}>
                {request.appListing.name}
              </Text>
            )}
            {request.appListing?.externalUrl && (
              <Group gap={6}>
                <Text size="xs" c="dimmed">
                  URL
                </Text>
                {validateExternalUrl(request.appListing.externalUrl).ok ? (
                  <Anchor
                    href={request.appListing.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="sm"
                  >
                    <Group gap={4} wrap="nowrap">
                      {request.appListing.externalUrl}
                      <IconExternalLink size={12} />
                    </Group>
                  </Anchor>
                ) : (
                  // Non-https (defense-in-depth) → render as INERT text, never a
                  // clickable link on the moderator surface.
                  <Text size="sm" c="red">
                    {request.appListing.externalUrl} (not a valid https link)
                  </Text>
                )}
              </Group>
            )}
            <Group gap={12}>
              {request.appListing?.category && (
                <Badge size="sm" variant="light">
                  {request.appListing.category}
                </Badge>
              )}
              {request.appListing?.contentRating && (
                <Badge size="sm" color="gray" variant="light">
                  {request.appListing.contentRating}
                </Badge>
              )}
            </Group>
            {request.changelog && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  Submitter note
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {request.changelog}
                </Text>
              </Stack>
            )}
          </Stack>
        </Card>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Content review checklist
          </Text>
          <List spacing={4} size="sm" center>
            {checklist.map((item) => (
              <List.Item
                key={item.id}
                icon={
                  <ThemeIcon
                    size={18}
                    radius="xl"
                    color={item.status === 'ok' ? 'green' : item.status === 'warn' ? 'red' : 'gray'}
                    variant={item.status === 'todo' ? 'light' : 'filled'}
                  >
                    {item.status === 'ok' ? (
                      <IconCheck size={12} />
                    ) : item.status === 'warn' ? (
                      <IconX size={12} />
                    ) : (
                      <IconQuestionMark size={12} />
                    )}
                  </ThemeIcon>
                }
              >
                <Text size="sm">{item.label}</Text>
                <Text size="xs" c="dimmed">
                  {item.hint}
                </Text>
              </List.Item>
            ))}
          </List>
        </Stack>

        {assetsIncomplete && (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">
              Assets are incomplete — approve will be rejected by the server until an icon, a cover
              and ≥1 screenshot are attached.
            </Text>
          </Alert>
        )}

        {actionMode === 'reject' ? (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Rejection reason
            </Text>
            <Textarea
              autosize
              minRows={3}
              maxRows={10}
              placeholder="Explain what needs to change (≥10 chars, shown to the author)."
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.currentTarget.value)}
              disabled={busy}
              data-testid="apps-offsite-reject-reason"
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
                data-testid="apps-offsite-reject-confirm"
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
                data-testid="apps-offsite-reject-open"
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
                Approve
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

// ===========================================================================
// P3b PR3 — the mod REPORT QUEUE (Reports tab) + per-listing moderation history.
//
// Dark + mod-only (the whole /apps/review page requires isModerator, and every
// proc here is `moderatorProcedure`). The report-row action set + status chips are
// computed by the pure `appListingModerationView` view-model (unit-tested).
// ===========================================================================

type ReportReporter = { id: number; username: string | null; image: string | null };

type ReportRow = {
  id: string;
  appListingId: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string | Date;
  resolvedAt: string | Date | null;
  reporter: ReportReporter | null;
  appListing: {
    slug: string | null;
    name: string | null;
    kind: string | null;
    status: string | null;
  } | null;
};

type ReportList = { items: ReportRow[]; nextCursor: string | null };

type ReportStatusFilter = 'pending' | 'resolved' | 'dismissed';

export function OffsiteReportsQueue() {
  const features = useFeatureFlags();
  const [statusFilter, setStatusFilter] = useState<ReportStatusFilter>('pending');
  const [pending, setPending] = useState<{ action: ReportRowAction; report: ReportRow } | null>(
    null
  );
  const [historyFor, setHistoryFor] = useState<ReportRow | null>(null);

  const queue = trpc.appListings.listListingReports.useQuery(
    { status: statusFilter, limit: 50 },
    { enabled: !!features?.appBlocks, retry: false }
  );

  // Flag off / not a mod → the query errors (moderatorProcedure); render nothing.
  if (queue.error) return null;

  const items = (queue.data?.items ?? []) as ReportRow[];

  return (
    <Stack gap="sm" mt="lg">
      <Divider
        label={
          <Group gap={6}>
            <IconFlag size={14} />
            <Text size="sm" fw={600}>
              Off-site listing reports
            </Text>
            <Badge size="sm" variant="light" color={items.length > 0 ? 'red' : 'gray'}>
              {items.length}
            </Badge>
          </Group>
        }
        labelPosition="left"
      />
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          User reports of approved off-site apps. Verify ownership out-of-band, then delist / relist
          / purge and resolve or dismiss the report.
        </Text>
        <SegmentedControl
          size="xs"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as ReportStatusFilter)}
          data={[
            { label: 'Pending', value: 'pending' },
            { label: 'Resolved', value: 'resolved' },
            { label: 'Dismissed', value: 'dismissed' },
          ]}
        />
      </Group>

      {queue.isLoading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading…
          </Text>
        </Group>
      ) : items.length === 0 ? (
        <Card withBorder p="md">
          <Group gap="xs">
            <IconCheck color="var(--mantine-color-green-6)" size={18} />
            <Text size="sm">No {statusFilter} reports.</Text>
          </Group>
        </Card>
      ) : (
        <Card withBorder p={0}>
          <Table verticalSpacing="md" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Reason</Table.Th>
                <Table.Th>Reporter</Table.Th>
                <Table.Th>Reported</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((r) => {
                const listingChip = listingStatusChip(r.appListing?.status);
                const statusChip = reportStatusChip(r.status);
                const actions = reportRowActions({
                  reportStatus: r.status,
                  listingStatus: r.appListing?.status,
                });
                return (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Group gap={6}>
                        <Code>{r.appListing?.slug ?? '—'}</Code>
                        <Badge size="xs" color={listingChip.color} variant="light">
                          {listingChip.label}
                        </Badge>
                      </Group>
                      {r.appListing?.name && (
                        <Text size="xs" c="dimmed">
                          {r.appListing.name}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{getReportReasonLabel(r.reason)}</Text>
                      {r.details && (
                        <Text size="xs" c="dimmed" lineClamp={2} style={{ maxWidth: 260 }}>
                          {r.details}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        {r.reporter?.username ?? `#${r.reporter?.id ?? '?'}`}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <IconClock size={14} />
                        <Text size="xs">{formatDate(r.createdAt)}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" color={statusChip.color} variant="light">
                        {statusChip.label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        {actions.map((action) => (
                          <Button
                            key={action}
                            size="xs"
                            variant={isDestructiveAction(action) ? 'filled' : 'default'}
                            color={isDestructiveAction(action) ? 'red' : undefined}
                            onClick={() => setPending({ action, report: r })}
                            data-testid={`apps-report-${action}-${r.appListing?.slug ?? r.id}`}
                          >
                            {reportActionLabel(action)}
                          </Button>
                        ))}
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconHistory size={12} />}
                          onClick={() => setHistoryFor(r)}
                        >
                          History
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <ReportActionModal pending={pending} onClose={() => setPending(null)} />
      <ModerationHistoryModal report={historyFor} onClose={() => setHistoryFor(null)} />
    </Stack>
  );
}

/**
 * The reason/note + confirm modal for a single report-row action. delist/relist/
 * purge require a reason (≥{@link OFFSITE_MOD_REASON_MIN} chars); resolve/dismiss
 * take an optional note. Purge is destructive → an extra warning + a permanent
 * confirm label.
 */
function ReportActionModal({
  pending,
  onClose,
}: {
  pending: { action: ReportRowAction; report: ReportRow } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [text, setText] = useState('');

  async function afterSuccess(message: string) {
    showSuccessNotification({ message });
    await utils.appListings.listListingReports.invalidate();
    setText('');
    onClose();
  }
  function onError(title: string) {
    return (e: { message: string }) =>
      showErrorNotification({ title, error: new Error(e.message) });
  }

  const delistMut = trpc.appListings.delistListing.useMutation({
    onSuccess: () => afterSuccess('Listing delisted.'),
    onError: onError('Delist failed'),
  });
  const relistMut = trpc.appListings.relistListing.useMutation({
    onSuccess: () => afterSuccess('Listing relisted.'),
    onError: onError('Relist failed'),
  });
  const purgeMut = trpc.appListings.purgeListing.useMutation({
    onSuccess: () => afterSuccess('Listing purged.'),
    onError: onError('Purge failed'),
  });
  const resolveMut = trpc.appListings.resolveReport.useMutation({
    onSuccess: () => afterSuccess('Report resolved.'),
    onError: onError('Resolve failed'),
  });
  const dismissMut = trpc.appListings.dismissReport.useMutation({
    onSuccess: () => afterSuccess('Report dismissed.'),
    onError: onError('Dismiss failed'),
  });

  const busy =
    delistMut.isPending ||
    relistMut.isPending ||
    purgeMut.isPending ||
    resolveMut.isPending ||
    dismissMut.isPending;

  if (!pending) return null;
  const { action, report } = pending;
  const reasonRequired = action === 'delist' || action === 'relist' || action === 'purge';
  const trimmed = text.trim();
  const canSubmit = !busy && (!reasonRequired || trimmed.length >= OFFSITE_MOD_REASON_MIN);

  function submit() {
    switch (action) {
      case 'delist':
        return delistMut.mutate({
          appListingId: report.appListingId,
          reason: trimmed,
          reportId: report.id,
        });
      case 'relist':
        return relistMut.mutate({ appListingId: report.appListingId, reason: trimmed });
      case 'purge':
        return purgeMut.mutate({ appListingId: report.appListingId, reason: trimmed });
      case 'resolve':
        return resolveMut.mutate({ reportId: report.id, note: trimmed || undefined });
      case 'dismiss':
        return dismissMut.mutate({ reportId: report.id, note: trimmed || undefined });
    }
  }

  return (
    <Modal
      opened={!!pending}
      onClose={() => {
        if (busy) return;
        setText('');
        onClose();
      }}
      title={
        <Group gap={6}>
          <Text fw={600}>
            {reportActionLabel(action)} — {report.appListing?.slug ?? report.appListingId}
          </Text>
        </Group>
      }
      centered
    >
      <Stack gap="md">
        {isDestructiveAction(action) && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">
              Purge PERMANENTLY deletes this listing and its screenshots + reports. The audit event
              (with the slug snapshot) is kept. This cannot be undone.
            </Text>
          </Alert>
        )}
        <Textarea
          label={reasonRequired ? `Reason (≥${OFFSITE_MOD_REASON_MIN} chars, audited)` : 'Note (optional)'}
          autosize
          minRows={3}
          maxRows={8}
          placeholder={
            reasonRequired
              ? 'Why this action — recorded in the audit trail.'
              : 'Optional resolution note (audited).'
          }
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          disabled={busy}
          data-testid="apps-report-action-reason"
        />
        <Group justify="flex-end" gap="xs">
          <Button
            variant="default"
            onClick={() => {
              setText('');
              onClose();
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            color={isDestructiveAction(action) ? 'red' : undefined}
            onClick={submit}
            disabled={!canSubmit}
            loading={busy}
            data-testid="apps-report-action-confirm"
          >
            {isDestructiveAction(action) ? 'Purge permanently' : reportActionLabel(action)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type ModEvent = {
  id: string;
  appListingId: string | null;
  slug: string;
  action: string;
  reason: string | null;
  detail: string | null;
  before: unknown;
  after: unknown;
  reportId: string | null;
  createdAt: string | Date;
  actor: { id: number; username: string | null; image: string | null } | null;
};

type ModEventList = { items: ModEvent[]; nextCursor: string | null };

/** Read-only per-listing moderation history (newest-first audit trail). */
function ModerationHistoryModal({
  report,
  onClose,
}: {
  report: ReportRow | null;
  onClose: () => void;
}) {
  const features = useFeatureFlags();
  const query = trpc.appListings.listModerationEvents.useQuery(
    { appListingId: report?.appListingId ?? '', limit: 50 },
    { enabled: !!features?.appBlocks && !!report?.appListingId, retry: false }
  );

  if (!report) return null;
  const events = (query.data?.items ?? []) as ModEvent[];

  return (
    <Modal
      opened={!!report}
      onClose={onClose}
      title={
        <Group gap={6}>
          <IconHistory size={16} />
          <Text fw={600}>Moderation history — {report.appListing?.slug ?? report.appListingId}</Text>
        </Group>
      }
      size="lg"
      centered
    >
      {query.isLoading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading…
          </Text>
        </Group>
      ) : events.length === 0 ? (
        <Text size="sm" c="dimmed">
          No moderation events recorded for this listing yet.
        </Text>
      ) : (
        <Stack gap="xs">
          {events.map((e) => {
            const chip = moderationActionChip(e.action);
            return (
              <Card key={e.id} withBorder p="sm">
                <Group justify="space-between" gap="xs">
                  <Group gap={6}>
                    <Badge size="sm" color={chip.color} variant="light">
                      {chip.label}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      by {e.actor?.username ?? `#${e.actor?.id ?? '?'}`}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {formatDate(e.createdAt)}
                  </Text>
                </Group>
                {e.reason && (
                  <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                    {e.reason}
                  </Text>
                )}
              </Card>
            );
          })}
        </Stack>
      )}
    </Modal>
  );
}
