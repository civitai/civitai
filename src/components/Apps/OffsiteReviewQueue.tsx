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
  NumberInput,
  SegmentedControl,
  Select,
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
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import {
  ReasonGatedActionModal,
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonMeetsMin,
} from '~/components/Apps/ReasonGatedActionModal';
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
import {
  OFFSITE_CONTENT_RATINGS,
  type OffsiteContentRating,
} from '~/server/schema/blocks/offsite-listing.schema';
import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';
import {
  deriveContentRatingFromAssets,
  nsfwLevelFromContentRating,
} from '~/shared/constants/browsingLevel.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate as formatDateHelper } from '~/utils/date-helpers';
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

export type OffsitePendingRow = {
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

/**
 * Friendly whole-day "Month D, YYYY" form (e.g. "June 7, 2026") for the external-
 * review SUBMITTED timestamps — the modal's submitted line + the review queue's
 * "Submitted" column. A mod deciding on a submission cares about the calendar day,
 * not the minute. Audit-trail timestamps (report "Reported", moderation history)
 * keep the full local formatter above where time-of-day matters. Matches
 * `MySubmissionsList.formatSubmissionDate`.
 */
function formatSubmittedDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return formatDateHelper(d, 'MMMM D, YYYY');
}

export function OffsiteReviewQueue() {
  const features = useFeatureFlags();
  const [selected, setSelected] = useState<OffsitePendingRow | null>(null);

  const queue = trpc.appListings.listPendingRequests.useQuery(
    { limit: 50 },
    { enabled: !!features?.appBlocks, retry: false }
  );

  // Dark posture: flag off → nothing. An AUTHZ error (non-mod) → nothing. But a
  // TRANSIENT error must surface a retry rather than silently blank the section.
  if (!features?.appBlocks) return null;
  if (queue.error) {
    if (isModAuthzError(queue.error)) return null;
    return (
      <ModQueryError
        error={queue.error}
        onRetry={() => queue.refetch()}
        isRetrying={queue.isFetching}
        title="Couldn’t load external submissions"
        testId="apps-offsite-queue-error"
      />
    );
  }

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
                      <Text size="xs">{formatSubmittedDate(r.submittedAt)}</Text>
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

export function OffsiteReviewModal({
  request,
  onClose,
  onActioned,
}: {
  request: OffsitePendingRow | null;
  onClose: () => void;
  /** Fired after a successful approve/reject — lets a host (e.g. the mod
   *  management table) invalidate its own query in addition to the review queues. */
  onActioned?: () => void | Promise<void>;
}) {
  const utils = trpc.useUtils();
  const features = useFeatureFlags();
  const [rejectionReason, setRejectionReason] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');
  // 'view' shows only the two entry buttons; 'reject' / 'approve' each reveal their
  // own notes textarea + confirm (approve gated behind an explicit "Approve…" click,
  // mirroring reject — so a stray click can't approve with un-reviewed notes).
  const [actionMode, setActionMode] = useState<'view' | 'reject' | 'approve'>('view');
  // The mod's chosen final content rating. `null` = "follow the derived value" (the
  // Select shows the derived rating as its default); a non-null value is an explicit
  // override. The server FLOORS an under-rating override at the derived value.
  const [ratingOverride, setRatingOverride] = useState<OffsiteContentRating | null>(null);

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
      await onActioned?.();
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
      await onActioned?.();
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
    setRatingOverride(null);
    onClose();
  }

  if (!request) return null;

  const screenshots = (assetsQuery.data?.screenshots ?? []) as {
    imageId: number | null;
    nsfwLevel?: number | null;
  }[];
  const screenshotCount = screenshots.filter((s) => s.imageId != null).length;
  const hasIcon = assetsQuery.data?.iconId != null;
  const hasCover = assetsQuery.data?.coverId != null;

  // Content rating: DERIVE from the assets' max detected nsfwLevel (icon + cover +
  // screenshots), surface it ALONGSIDE the author-declared rating, and FLAG when the
  // assets are more mature than declared. The Select defaults to the derived value;
  // the mod may rate UP (an under-rating is floored server-side).
  const assetLevels: (number | null | undefined)[] = [
    (assetsQuery.data as { iconNsfwLevel?: number | null } | undefined)?.iconNsfwLevel,
    (assetsQuery.data as { coverNsfwLevel?: number | null } | undefined)?.coverNsfwLevel,
    ...screenshots.map((s) => s.nsfwLevel),
  ];
  const derivedRating = deriveContentRatingFromAssets(
    assetLevels.map((nsfwLevel) => ({ nsfwLevel: nsfwLevel ?? null }))
  );
  const declaredRating = request.appListing?.contentRating ?? null;
  const ratingMismatch =
    !assetsQuery.isLoading &&
    nsfwLevelFromContentRating(derivedRating) > nsfwLevelFromContentRating(declaredRating);
  const selectedRating: OffsiteContentRating = ratingOverride ?? derivedRating;

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
            · {formatSubmittedDate(request.submittedAt)}
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
            <Group gap={24}>
              {request.appListing?.category && (
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Category
                  </Text>
                  <Badge size="sm" variant="light">
                    {request.appListing.category}
                  </Badge>
                </Group>
              )}
              {request.appListing?.contentRating && (
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Content rating
                  </Text>
                  <Badge size="sm" color="gray" variant="light">
                    {request.appListing.contentRating}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    declared
                  </Text>
                </Group>
              )}
              {!assetsQuery.isLoading && (
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Detected from assets
                  </Text>
                  <Badge
                    size="sm"
                    color={ratingMismatch ? 'red' : 'blue'}
                    variant="light"
                    data-testid="apps-offsite-derived-rating"
                  >
                    {derivedRating}
                  </Badge>
                </Group>
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

        {ratingMismatch && (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            data-testid="apps-offsite-rating-mismatch"
          >
            <Text size="sm">
              Assets contain higher-maturity content ({derivedRating}) than the declared rating (
              {declaredRating ?? '—'}). The final rating defaults to the detected value; rate it at
              least that high.
            </Text>
          </Alert>
        )}

        {actionMode === 'reject' ? (
          <Stack gap="xs">
            <ReasonGatedField
              value={rejectionReason}
              onChange={setRejectionReason}
              disabled={busy}
              label="Rejection reason"
              placeholder={`Explain what needs to change (≥${OFFSITE_MOD_REASON_MIN} chars, shown to the author).`}
              testId="apps-offsite-reject-reason"
              minRows={3}
              maxRows={10}
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setActionMode('view')} disabled={busy}>
                Cancel
              </Button>
              <ReasonGatedSubmitButton
                onClick={() =>
                  rejectMut.mutate({
                    publishRequestId: request.id,
                    rejectionReason: rejectionReason.trim(),
                  })
                }
                gateOpen={reasonMeetsMin(rejectionReason)}
                busy={rejectMut.isPending}
                color="red"
                leftSection={<IconX size={14} />}
                label="Reject"
                testId="apps-offsite-reject-confirm"
              />
            </Group>
          </Stack>
        ) : actionMode === 'approve' ? (
          <Stack gap="xs">
            <Select
              label="Final content rating"
              description="Defaults to the rating detected from the assets. You may rate up; an under-rating is floored to the detected value on save."
              data={OFFSITE_CONTENT_RATINGS.map((r) => ({ value: r, label: r }))}
              value={selectedRating}
              onChange={(v) => setRatingOverride((v as OffsiteContentRating) ?? null)}
              disabled={busy}
              allowDeselect={false}
              data-testid="apps-offsite-approve-rating"
            />
            <Text size="sm" fw={600}>
              Approval notes (optional)
            </Text>
            <Textarea
              autosize
              minRows={2}
              maxRows={6}
              placeholder="Optional notes attached to the approval record."
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.currentTarget.value)}
              disabled={busy}
              data-testid="apps-offsite-approve-notes"
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setActionMode('view')} disabled={busy}>
                Cancel
              </Button>
              <Button
                color="green"
                leftSection={<IconCheck size={14} />}
                onClick={() =>
                  approveMut.mutate({
                    publishRequestId: request.id,
                    approvalNotes: approvalNotes.trim() || undefined,
                    contentRating: selectedRating,
                  })
                }
                disabled={busy}
                loading={approveMut.isPending}
                data-testid="apps-offsite-approve-confirm"
              >
                Approve
              </Button>
            </Group>
          </Stack>
        ) : (
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
              onClick={() => setActionMode('approve')}
              disabled={busy}
              data-testid="apps-offsite-approve-open"
            >
              Approve…
            </Button>
          </Group>
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

  // Dark posture: flag off / non-mod → nothing; a transient error → a retry Alert.
  if (!features?.appBlocks) return null;
  if (queue.error) {
    if (isModAuthzError(queue.error)) return null;
    return (
      <ModQueryError
        error={queue.error}
        onRetry={() => queue.refetch()}
        isRetrying={queue.isFetching}
        title="Couldn’t load reports"
        testId="apps-reports-queue-error"
      />
    );
  }

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
  // The claim target-owner id (a numeric userId; a mod may reassign to any real
  // user). Empty until the mod types one — claim submit is gated on a positive int.
  const [targetUserId, setTargetUserId] = useState<number | ''>('');

  async function afterSuccess(message: string) {
    showSuccessNotification({ message });
    await utils.appListings.listListingReports.invalidate();
    setText('');
    setTargetUserId('');
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
  const claimMut = trpc.appListings.claimListing.useMutation({
    onSuccess: () => afterSuccess('Ownership reassigned.'),
    onError: onError('Claim failed'),
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
    claimMut.isPending ||
    purgeMut.isPending ||
    resolveMut.isPending ||
    dismissMut.isPending;

  if (!pending) return null;
  const { action, report } = pending;
  const reasonRequired =
    action === 'delist' || action === 'relist' || action === 'claim' || action === 'purge';
  const isClaim = action === 'claim';
  const destructive = isDestructiveAction(action);
  const trimmed = text.trim();
  const validTarget = typeof targetUserId === 'number' && Number.isInteger(targetUserId) && targetUserId > 0;

  function reset() {
    setText('');
    setTargetUserId('');
    onClose();
  }

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
      case 'claim':
        // Narrow to a concrete number (validTarget alone doesn't narrow the union).
        if (typeof targetUserId !== 'number' || !validTarget) return;
        return claimMut.mutate({
          appListingId: report.appListingId,
          targetUserId,
          reason: trimmed,
          // The claim here is always initiated from a report row (the impersonation
          // report → delist → claim flow), so link + resolve that report in the same
          // tx — exactly like the delist action above.
          reportId: report.id,
        });
      case 'purge':
        return purgeMut.mutate({ appListingId: report.appListingId, reason: trimmed });
      case 'resolve':
        return resolveMut.mutate({ reportId: report.id, note: trimmed || undefined });
      case 'dismiss':
        return dismissMut.mutate({ reportId: report.id, note: trimmed || undefined });
    }
  }

  return (
    <ReasonGatedActionModal
      opened={!!pending}
      onCancel={reset}
      busy={busy}
      title={
        <Group gap={6}>
          <Text fw={600}>
            {reportActionLabel(action)} — {report.appListing?.slug ?? report.appListingId}
          </Text>
        </Group>
      }
      reason={text}
      onReasonChange={setText}
      reasonRequired={reasonRequired}
      reasonLabel={
        reasonRequired ? `Reason (≥${OFFSITE_MOD_REASON_MIN} chars, audited)` : 'Note (optional)'
      }
      reasonPlaceholder={
        reasonRequired
          ? 'Why this action — recorded in the audit trail.'
          : 'Optional resolution note (audited).'
      }
      reasonTestId="apps-report-action-reason"
      destructive={destructive}
      destructiveWarning={
        <Text size="sm">
          Purge PERMANENTLY deletes this listing and its screenshots + reports. The audit event
          (with the slug snapshot) is kept. This cannot be undone.
        </Text>
      }
      extraSlot={
        isClaim ? (
          <>
            <Alert color="blue" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">
                Reassigns the listing OWNER to the user id below (verify ownership out-of-band
                first). The original submission record is preserved. Reversible via a later claim.
              </Text>
            </Alert>
            <NumberInput
              label="New owner user id"
              placeholder="e.g. 12345"
              value={targetUserId}
              onChange={(v) => setTargetUserId(typeof v === 'number' ? v : '')}
              min={1}
              allowNegative={false}
              allowDecimal={false}
              disabled={busy}
              data-testid="apps-report-claim-target"
            />
          </>
        ) : undefined
      }
      extraGateSatisfied={!isClaim || validTarget}
      extraGateTooltip="Enter a valid new owner id."
      submitLabel={destructive ? 'Purge permanently' : reportActionLabel(action)}
      submitTestId="apps-report-action-confirm"
      onSubmit={submit}
    />
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

/**
 * The ownership transfer carried by a `claim` event's `{userId}`-shaped before/after.
 * Returns null for any non-claim event (delist/relist/purge/report-* carry a
 * `{status}`-shaped before/after instead), so the history row only renders the
 * transfer for claims — it never mis-reads a status event's payload. before/after are
 * typed `unknown` (JSON columns), so each userId is narrowed to a number defensively.
 */
function claimOwnerTransfer(e: ModEvent): { from: number | null; to: number | null } | null {
  if (e.action !== 'claim') return null;
  const before = (e.before ?? null) as { userId?: unknown } | null;
  const after = (e.after ?? null) as { userId?: unknown } | null;
  const from = typeof before?.userId === 'number' ? before.userId : null;
  const to = typeof after?.userId === 'number' ? after.userId : null;
  if (from === null && to === null) return null;
  return { from, to };
}

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
            const transfer = claimOwnerTransfer(e);
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
                {transfer && (
                  <Text size="xs" c="dimmed" mt={4} data-testid={`apps-mod-event-owner-${e.id}`}>
                    owner: {transfer.from ?? '?'} → {transfer.to ?? '?'}
                  </Text>
                )}
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
