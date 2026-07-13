import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Textarea,
} from '@mantine/core';
import { IconAlertTriangle, IconBox, IconThumbUp } from '@tabler/icons-react';
import { Fragment, useMemo, useState } from 'react';
import {
  OffsiteReviewModal,
  type OffsitePendingRow,
} from '~/components/Apps/OffsiteReviewQueue';
import { listingStatusChip } from '~/components/Apps/appListingModerationView';
import {
  isDestructiveListingModAction,
  listingKindChip,
  listingModActionLabel,
  listingModActions,
  type ListingModAction,
} from '~/components/Apps/appListingModerationTableView';
import {
  MOD_STATUS_BUCKETS,
  MOD_STATUS_SECTION_ORDER,
  bucketGroupsByStatus,
  groupSubmissionsByApp,
  nextSortState,
  sortGroups,
  toDate,
  type SortColumn,
  type SortState,
  type SubmissionAccessors,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';
import { SortableTh, StatusSections, SubmissionSearch } from '~/components/Apps/submissionsTableUi';
import type { ModerationListingRow } from '~/server/services/blocks/app-listing.service';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/review — the unified MODERATOR listings management table (W13 post-approval
 * mgmt, P2). Reads `appListings.listAllListingsForModeration` (mod-only, all
 * statuses) and renders it as the shared status SECTIONS
 * (Live / Pending / Rejected / Removed / Draft) with a per-row kind badge, an owner
 * chip, and KIND-AWARE inline lifecycle actions wired to the merged Phase 1 procs:
 *   - pending  → Review (opens the existing off-site review modal to approve/reject),
 *   - approved → Reset to pending (off-site) + Hide (delist, dual-kind),
 *   - removed  → Relist (dual-kind) + Claim + Purge (off-site; Purge is destructive),
 *   - draft/rejected → read-only (unless a pending request offers Review).
 *
 * Dark + mod-only: the whole /apps/review page requires `isAppReviewer`, the query
 * is `moderatorProcedure`, and a query error (non-mod / flag off) renders nothing.
 * Closes the "manage any listing without a report" gap (the report queue only
 * surfaces reported listings) + gives the pending review its table-parity home.
 */

const MOD_ACCESSORS: SubmissionAccessors<ModerationListingRow> = {
  identity: (r) => r.id,
  name: (r) => r.name || r.slug,
  slug: (r) => r.slug,
  status: (r) => r.status,
  submittedAt: (r) => toDate(r.pendingRequest?.submittedAt ?? null),
  reviewedAt: () => null,
};

type KindFilter = 'all' | 'onsite' | 'offsite';

/** Build the off-site review-modal row from a pending moderation listing row. */
function toReviewRow(row: ModerationListingRow): OffsitePendingRow | null {
  const pending = row.pendingRequest;
  if (!pending) return null;
  return {
    id: pending.id,
    appListingId: row.id,
    slug: row.slug,
    status: 'pending',
    submittedAt: pending.submittedAt,
    changelog: pending.changelog,
    appListing: {
      name: row.name,
      externalUrl: row.externalUrl,
      category: row.category,
      contentRating: row.contentRating,
    },
    submittedBy: pending.submittedBy,
  };
}

export function AppListingsModerationTable() {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [sort, setSort] = useState<SortState>({ column: 'app', direction: 'asc' });
  const [reviewRow, setReviewRow] = useState<OffsitePendingRow | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    action: ListingModAction;
    row: ModerationListingRow;
  } | null>(null);

  const query = trpc.appListings.listAllListingsForModeration.useQuery(
    {
      limit: 50,
      search: search.trim() || undefined,
      kind: kind === 'all' ? undefined : kind,
    },
    { enabled: !!features?.appBlocks, retry: false }
  );

  const invalidate = () => utils.appListings.listAllListingsForModeration.invalidate();

  const items = (query.data?.items ?? []) as ModerationListingRow[];

  // Group (one group per listing — the mod view isn't version-collapsed), sort by
  // the chosen column, then partition into the MOD status sections.
  const buckets = useMemo(() => {
    const grouped = groupSubmissionsByApp(items, MOD_ACCESSORS.identity, MOD_ACCESSORS.submittedAt);
    const sorted = sortGroups(grouped, sort, MOD_ACCESSORS);
    return bucketGroupsByStatus(sorted, MOD_ACCESSORS.status, MOD_STATUS_BUCKETS);
  }, [items, sort]);

  const totalGroups = MOD_STATUS_SECTION_ORDER.reduce((n, b) => n + buckets[b].length, 0);

  // The query errors when the caller isn't a mod / the flag is off → render nothing
  // (unobtrusive, mirrors the sibling mod queues).
  if (query.error) return null;

  const onSort = (column: SortColumn) => setSort((s) => nextSortState(s, column));

  const openAction = (action: ListingModAction, row: ModerationListingRow) => {
    if (action === 'review') {
      const reviewable = toReviewRow(row);
      if (reviewable) setReviewRow(reviewable);
      return;
    }
    setPendingAction({ action, row });
  };

  const renderTable = (groups: SubmissionGroup<ModerationListingRow>[]) => (
    <Card withBorder p={0}>
      <Table verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <SortableTh label="App" column="app" sort={sort} onSort={onSort} />
            <Table.Th>Owner</Table.Th>
            <Table.Th>Category</Table.Th>
            <Table.Th>Reviews</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {groups.map((g) => {
            const row = g.latest;
            const kindChip = listingKindChip(row.kind);
            const statusChip = listingStatusChip(row.status);
            const actions = listingModActions({
              status: row.status,
              kind: row.kind,
              hasPendingRequest: row.pendingRequest != null,
            });
            return (
              <Fragment key={row.id}>
                <Table.Tr data-testid={`apps-mod-listing-row-${row.slug}`}>
                  <Table.Td>
                    <Group gap={6}>
                      <Code>{row.slug}</Code>
                      <Badge size="xs" color={kindChip.color} variant="light">
                        {kindChip.label}
                      </Badge>
                      <Badge size="xs" color={statusChip.color} variant="light">
                        {statusChip.label}
                      </Badge>
                    </Group>
                    {row.name && (
                      <Text size="xs" c="dimmed">
                        {row.name}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {row.owner?.username ? `@${row.owner.username}` : `#${row.owner?.id ?? '?'}`}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {row.category ? (
                      <Badge size="sm" variant="light">
                        {row.category}
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      <Badge
                        size="sm"
                        variant="light"
                        color="green"
                        leftSection={<IconThumbUp size={12} />}
                        title="Recommend (thumbs up) count"
                      >
                        {row.thumbsUpCount}
                      </Badge>
                      <Badge
                        size="sm"
                        variant="light"
                        color="blue"
                        leftSection={<IconBox size={12} />}
                        title="Install count"
                      >
                        {row.installCount}
                      </Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {actions.length === 0 ? (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    ) : (
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        {actions.map((action) => (
                          <Button
                            key={action}
                            size="xs"
                            variant={isDestructiveListingModAction(action) ? 'filled' : 'default'}
                            color={
                              isDestructiveListingModAction(action)
                                ? 'red'
                                : action === 'review'
                                ? 'blue'
                                : undefined
                            }
                            onClick={() => openAction(action, row)}
                            data-testid={`apps-mod-${action}-${row.slug}`}
                          >
                            {listingModActionLabel(action)}
                          </Button>
                        ))}
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Card>
  );

  return (
    <Stack gap="md" mt="lg">
      <Group justify="space-between" align="flex-end">
        <SubmissionSearch
          value={search}
          onChange={setSearch}
          testId="apps-mod-listings-filter"
          placeholder="Filter by app name or slug…"
        />
        <SegmentedControl
          size="xs"
          value={kind}
          onChange={(v) => setKind(v as KindFilter)}
          data={[
            { label: 'All', value: 'all' },
            { label: 'On-site', value: 'onsite' },
            { label: 'External', value: 'offsite' },
          ]}
        />
      </Group>

      {query.isLoading ? (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      ) : totalGroups === 0 ? (
        <Card withBorder p="md">
          <Text size="sm" c="dimmed" ta="center" py="sm">
            No listings match the current filters.
          </Text>
        </Card>
      ) : (
        <StatusSections
          buckets={buckets}
          testIdPrefix="apps-mod-listings-section"
          order={MOD_STATUS_SECTION_ORDER}
          renderTable={renderTable}
        />
      )}

      <OffsiteReviewModal
        request={reviewRow}
        onClose={() => setReviewRow(null)}
        onActioned={invalidate}
      />
      <ListingModActionModal
        pending={pendingAction}
        onClose={() => setPendingAction(null)}
        onDone={invalidate}
      />
    </Stack>
  );
}

/**
 * The reason/confirm modal for a single lifecycle action (reset-to-pending / hide /
 * relist / claim / purge). Every action requires a reason (≥{@link
 * OFFSITE_MOD_REASON_MIN} chars, audited); `claim` also needs a numeric target
 * owner id; `purge` is destructive → an extra warning + a permanent confirm label.
 */
function ListingModActionModal({
  pending,
  onClose,
  onDone,
}: {
  pending: { action: ListingModAction; row: ModerationListingRow } | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [targetUserId, setTargetUserId] = useState<number | ''>('');

  async function afterSuccess(message: string) {
    showSuccessNotification({ message });
    await onDone();
    setReason('');
    setTargetUserId('');
    onClose();
  }
  function onError(title: string) {
    return (e: { message: string }) =>
      showErrorNotification({ title, error: new Error(e.message) });
  }

  const resetMut = trpc.appListings.resetListingToPending.useMutation({
    onSuccess: () => afterSuccess('Listing reset to pending.'),
    onError: onError('Reset failed'),
  });
  const delistMut = trpc.appListings.delistListing.useMutation({
    onSuccess: () => afterSuccess('Listing hidden.'),
    onError: onError('Hide failed'),
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

  const busy =
    resetMut.isPending ||
    delistMut.isPending ||
    relistMut.isPending ||
    claimMut.isPending ||
    purgeMut.isPending;

  if (!pending) return null;
  const { action, row } = pending;
  const isClaim = action === 'claim';
  const destructive = isDestructiveListingModAction(action);
  const trimmed = reason.trim();
  const validTarget =
    typeof targetUserId === 'number' && Number.isInteger(targetUserId) && targetUserId > 0;
  const canSubmit =
    !busy && trimmed.length >= OFFSITE_MOD_REASON_MIN && (!isClaim || validTarget);

  function submit() {
    switch (action) {
      case 'reset-to-pending':
        return resetMut.mutate({ appListingId: row.id, reason: trimmed });
      case 'hide':
        return delistMut.mutate({ appListingId: row.id, reason: trimmed });
      case 'relist':
        return relistMut.mutate({ appListingId: row.id, reason: trimmed });
      case 'claim':
        if (typeof targetUserId !== 'number' || !validTarget) return;
        return claimMut.mutate({ appListingId: row.id, targetUserId, reason: trimmed });
      case 'purge':
        return purgeMut.mutate({ appListingId: row.id, reason: trimmed });
    }
  }

  function reset() {
    setReason('');
    setTargetUserId('');
    onClose();
  }

  return (
    <Modal
      opened={!!pending}
      onClose={() => {
        if (busy) return;
        reset();
      }}
      title={
        <Text fw={600}>
          {listingModActionLabel(action)} — {row.slug}
        </Text>
      }
      centered
    >
      <Stack gap="md">
        {destructive && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">
              Purge PERMANENTLY deletes this listing and its screenshots + reports. The audit event
              (with the slug snapshot) is kept. This cannot be undone.
            </Text>
          </Alert>
        )}
        {isClaim && (
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
              data-testid="apps-mod-claim-target"
            />
          </>
        )}
        <Textarea
          label={`Reason (≥${OFFSITE_MOD_REASON_MIN} chars, audited)`}
          autosize
          minRows={3}
          maxRows={8}
          placeholder="Why this action — recorded in the audit trail."
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          disabled={busy}
          data-testid="apps-mod-action-reason"
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={reset} disabled={busy}>
            Cancel
          </Button>
          <Button
            color={destructive ? 'red' : undefined}
            onClick={submit}
            disabled={!canSubmit}
            loading={busy}
            data-testid="apps-mod-action-confirm"
          >
            {destructive ? 'Purge permanently' : listingModActionLabel(action)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
