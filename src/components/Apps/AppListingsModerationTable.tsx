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
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconBox, IconThumbUp } from '@tabler/icons-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
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

/** The server-side status filter (the primary "reach a specific bucket" affordance).
 *  `'all'` = no filter; otherwise the raw `AppListing.status` ('Live' = approved). */
type StatusFilter = 'all' | 'approved' | 'pending' | 'rejected' | 'removed' | 'draft';

const STATUS_FILTER_OPTIONS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Live', value: 'approved' },
  { label: 'Pending', value: 'pending' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Removed', value: 'removed' },
  { label: 'Draft', value: 'draft' },
];

/** Rows per keyset page (bounded by the schema at ≤50). */
const PAGE_SIZE = 50;

/** A non-mod-table sort column, used as the "no active sort" sentinel so the App
 *  header renders neutral until a mod explicitly clicks it (the default order is the
 *  server keyset — newest-first — NOT a client alphabetical re-sort of a truncated
 *  window, which would misrepresent completeness). */
const NEUTRAL_SORT: SortState = { column: 'reviewed', direction: 'asc' };

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // `null` = the server keyset order (newest-first). A client sort is opt-in (a mod
  // clicks the App header) and is labelled as covering only the LOADED rows.
  const [sort, setSort] = useState<SortState | null>(null);
  // Keyset pagination: `cursor` drives the query; `accumulated` holds the pages
  // already loaded so "Load more" APPENDS rather than replaces.
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<ModerationListingRow[]>([]);
  const [reviewRow, setReviewRow] = useState<OffsitePendingRow | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    action: ListingModAction;
    row: ModerationListingRow;
  } | null>(null);

  // A filter change = a NEW result set → reset pagination (don't append across it).
  const trimmedSearch = search.trim();
  const filterKey = `${statusFilter}|${kind}|${trimmedSearch}`;
  useEffect(() => {
    setAccumulated([]);
    setCursor(undefined);
  }, [filterKey]);

  const query = trpc.appListings.listAllListingsForModeration.useQuery(
    {
      limit: PAGE_SIZE,
      search: trimmedSearch || undefined,
      kind: kind === 'all' ? undefined : kind,
      status: statusFilter === 'all' ? undefined : statusFilter,
      cursor,
    },
    { enabled: !!features?.appBlocks, retry: false }
  );

  // Reset to page 1 on a mutation (a listing's status/order may shift) + invalidate.
  const invalidate = () => {
    setAccumulated([]);
    setCursor(undefined);
    return utils.appListings.listAllListingsForModeration.invalidate();
  };

  const page = (query.data?.items ?? []) as ModerationListingRow[];
  const nextCursor = query.data?.nextCursor ?? null;

  // Merge the current page into the accumulated set (dedupe by id — defensive).
  const items = useMemo(() => {
    if (!cursor) return page;
    const seen = new Set(accumulated.map((r) => r.id));
    return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
  }, [accumulated, page, cursor]);

  // Group (one group per listing — the mod view isn't version-collapsed), apply the
  // (opt-in) client sort, then partition into the MOD status sections. When `sort`
  // is null the server keyset order (newest-first) is preserved.
  const buckets = useMemo(() => {
    const grouped = groupSubmissionsByApp(items, MOD_ACCESSORS.identity, MOD_ACCESSORS.submittedAt);
    const ordered = sort ? sortGroups(grouped, sort, MOD_ACCESSORS) : grouped;
    return bucketGroupsByStatus(ordered, MOD_ACCESSORS.status, MOD_STATUS_BUCKETS);
  }, [items, sort]);

  const totalGroups = MOD_STATUS_SECTION_ORDER.reduce((n, b) => n + buckets[b].length, 0);

  // The query errors when the caller isn't a mod / the flag is off → render nothing
  // (unobtrusive, mirrors the sibling mod queues).
  if (query.error) return null;

  const onSort = (column: SortColumn) =>
    setSort((s) => nextSortState(s ?? { column: 'app', direction: 'desc' }, column));
  const onLoadMore = () => {
    setAccumulated(items);
    if (nextCursor) setCursor(nextCursor);
  };

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
            <SortableTh label="App" column="app" sort={sort ?? NEUTRAL_SORT} onSort={onSort} />
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

  // Honest completeness signal: whenever a next page exists the loaded set is a
  // TRUNCATED window (the newest `items.length`), so the view must never read as a
  // complete list — surface the count + the Load-more affordance, and (when a client
  // sort is active) note the sort covers only the loaded rows.
  const truncated = nextCursor != null;

  return (
    <Stack gap="md" mt="lg">
      <Group justify="space-between" align="flex-end">
        <SubmissionSearch
          value={search}
          onChange={setSearch}
          testId="apps-mod-listings-filter"
          placeholder="Filter by app name or slug…"
        />
        <Group gap="sm">
          <SegmentedControl
            size="xs"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            data={STATUS_FILTER_OPTIONS}
            aria-label="Filter by status"
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
            aria-label="Filter by kind"
          />
        </Group>
      </Group>

      {query.isLoading && items.length === 0 ? (
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
        <>
          <Group gap={6}>
            <Text size="xs" c="dimmed" data-testid="apps-mod-listings-count">
              Showing {items.length}
              {truncated ? '+ (more listings exist — Load more or narrow the filters)' : ''}.
            </Text>
            {truncated && sort && (
              <Text size="xs" c="orange" data-testid="apps-mod-sort-partial-note">
                Sort covers only the loaded rows — Load more or filter to include the rest.
              </Text>
            )}
          </Group>

          <StatusSections
            buckets={buckets}
            testIdPrefix="apps-mod-listings-section"
            order={MOD_STATUS_SECTION_ORDER}
            renderTable={renderTable}
          />

          {truncated && (
            <Group justify="center">
              <Button
                variant="default"
                onClick={onLoadMore}
                loading={query.isFetching}
                disabled={query.isFetching}
                data-testid="apps-mod-load-more"
              >
                Load more
              </Button>
            </Group>
          )}
        </>
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
  // Typed-confirmation for the irreversible Purge: the mod must type the listing
  // slug (in ADDITION to the reason) before the destructive button enables.
  const [confirmText, setConfirmText] = useState('');

  async function afterSuccess(message: string) {
    showSuccessNotification({ message });
    await onDone();
    setReason('');
    setTargetUserId('');
    setConfirmText('');
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
  // Purge additionally requires the mod to type the exact listing slug (typed-confirm).
  const confirmMatches = confirmText.trim() === row.slug;
  const canSubmit =
    !busy &&
    trimmed.length >= OFFSITE_MOD_REASON_MIN &&
    (!isClaim || validTarget) &&
    (!destructive || confirmMatches);

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
    setConfirmText('');
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
          <>
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">
                Purge PERMANENTLY deletes this listing and its screenshots + reports. The audit
                event (with the slug snapshot) is kept. This cannot be undone.
              </Text>
            </Alert>
            <TextInput
              label={
                <Text size="sm">
                  Type the slug <Code>{row.slug}</Code> to confirm
                </Text>
              }
              placeholder={row.slug}
              value={confirmText}
              onChange={(e) => setConfirmText(e.currentTarget.value)}
              disabled={busy}
              error={
                confirmText.length > 0 && !confirmMatches ? 'Does not match the slug' : undefined
              }
              data-testid="apps-mod-purge-confirm"
            />
          </>
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
