import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconBox, IconThumbUp } from '@tabler/icons-react';
import { keepPreviousData } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';
import { MessageAppOwnerModal } from '~/components/Apps/MessageAppOwnerModal';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import { ReasonGatedActionModal } from '~/components/Apps/ReasonGatedActionModal';
import { listingStatusChip } from '~/components/Apps/appListingModerationView';
import { LISTING_KIND_LABELS } from '~/components/Apps/listingKindLabels';
import {
  actionOpensOwnerMessage,
  actionRequiresReason,
  effectiveModerationStatus,
  isDestructiveListingModAction,
  listingKindChip,
  listingModActionLabel,
  listingModActionsForRow,
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
import { marketplaceCategoryLabel } from '~/server/services/blocks/marketplace-categories.constants';
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
 *   - draft/rejected → no LIFECYCLE action (unless a pending request offers Review).
 *
 * Plus one action on EVERY row, of every status and both kinds: Message owner, which
 * opens `MessageAppOwnerModal` and calls `appListings.messageAppOwner`. It is the only
 * action here that changes no listing state, and it is unconditional because the proc
 * has no status branch — see `listingModActions`. It is also why a draft/rejected row
 * no longer renders a dead `—`.
 *
 * Dark + mod-only: the whole /apps/review page requires `isAppReviewer`, the query
 * is `moderatorProcedure`, and a query error (non-mod / flag off) renders nothing.
 * Closes the "manage any listing without a report" gap (the report queue only
 * surfaces reported listings) + gives the pending review its table-parity home.
 *
 * The off-site review MODAL is PAGE-OWNED (lifted to `src/pages/apps/review.tsx`)
 * so there is a single, non-divergent instance shared with the unified Pending
 * list. A pending row's Review action calls the page's `openOffsiteReview` (passing
 * this table's own `invalidate` as the post-action callback so the table refreshes).
 * The lifecycle-action modal (`ListingModActionModal`) stays LOCAL to this table.
 */

const MOD_ACCESSORS: SubmissionAccessors<ModerationListingRow> = {
  identity: (r) => r.id,
  name: (r) => r.name || r.slug,
  slug: (r) => r.slug,
  // Bucket by the EFFECTIVE status so a draft-with-a-live-pending-request lands in
  // the Pending section (it's an external listing awaiting its first review).
  status: (r) => effectiveModerationStatus(r),
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

export function AppListingsModerationTable({
  openOffsiteReview,
}: {
  /** Opens the PAGE-OWNED off-site review modal. The second arg is fired after a
   *  successful approve/reject so this table can invalidate + reset its own paging. */
  openOffsiteReview: (row: OffsitePendingRow, onActioned?: () => void | Promise<void>) => void;
}) {
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
  const [pendingAction, setPendingAction] = useState<{
    action: ListingModAction;
    row: ModerationListingRow;
  } | null>(null);
  // The owner-message composer is a SEPARATE piece of state from `pendingAction`: it
  // opens its own modal (different fields, different floors — see
  // `MessageAppOwnerModal`), and keeping the two apart means a lifecycle action can
  // never render the message form's gate, or vice versa.
  const [messageRow, setMessageRow] = useState<ModerationListingRow | null>(null);

  // A filter/search change = a NEW result set → reset pagination SYNCHRONOUSLY in the
  // onChange handler (batched with the filter state change in the same React event) so
  // there's no render where the OLD cursor is paired with the NEW filter — that stale
  // window fired one query with a mismatched cursor. Search is DEBOUNCED so keystrokes
  // don't storm the server; the raw `search` drives the input, `debouncedSearch` the
  // query. Resetting on each keystroke keeps the debounced query cursor-clean.
  const [debouncedSearch] = useDebouncedValue(search.trim(), 300);
  const resetPaging = () => {
    setAccumulated([]);
    setCursor(undefined);
  };
  const onSearchChange = (value: string) => {
    resetPaging();
    setSearch(value);
  };
  const onKindChange = (value: KindFilter) => {
    resetPaging();
    setKind(value);
  };
  const onStatusChange = (value: StatusFilter) => {
    resetPaging();
    setStatusFilter(value);
  };

  const query = trpc.appListings.listAllListingsForModeration.useQuery(
    {
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
      kind: kind === 'all' ? undefined : kind,
      status: statusFilter === 'all' ? undefined : statusFilter,
      cursor,
    },
    {
      enabled: !!features?.appBlocks,
      retry: false,
      // Keep the last page visible WHILE the next one loads so the Load-more block
      // (driven by `query.data.nextCursor`) doesn't unmount mid-fetch and flicker.
      placeholderData: keepPreviousData,
    }
  );

  // Reset to page 1 on a mutation (a listing's status/order may shift) + invalidate.
  const invalidate = () => {
    resetPaging();
    return utils.appListings.listAllListingsForModeration.invalidate();
  };

  const page = (query.data?.items ?? []) as ModerationListingRow[];
  const nextCursor = query.data?.nextCursor ?? null;

  // Merge the current page into the accumulated set (dedupe by id — defensive), then
  // drop on-site + pending rows: those live in the actionable on-site review FIFO
  // queue, and listing them here too would put one item in two moderator surfaces with
  // different action sets. Off-site pending stays (it carries the Review action).
  //
  // 🔴 THE OLD REASON FOR THIS FILTER IS NO LONGER TRUE, and the gap it leaves is real.
  // It used to read "here they'd render as a dead-end `—`-action row" — that stopped
  // being the case the moment `message-owner` became unconditional, since such a row now
  // offers Message owner. So this table cannot message the owner of an on-site listing
  // while it is awaiting review, which is one of the states a developer most needs to
  // hear from a moderator in. Deliberately NOT widened here: which rows a live
  // moderator surface lists is a product decision about surface duplication, not a
  // should-fix on the composer. Closing it means giving the on-site review queue its own
  // composer entry point (which also means adding that queue to the mount ledger in
  // `__tests__/appModeratorMessageForm.callSites.test.ts`).
  const items = useMemo(() => {
    const merged = !cursor
      ? page
      : (() => {
          const seen = new Set(accumulated.map((r) => r.id));
          return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
        })();
    return merged.filter(
      (r) => !(r.kind === 'onsite' && effectiveModerationStatus(r) === 'pending')
    );
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

  // Dark posture: the flag being off → render nothing (the query never runs). An
  // AUTHZ error (a non-mod somehow reaching the moderatorProcedure) → also nothing.
  // But a TRANSIENT error (500 / network) must NOT silently blank the whole surface —
  // it renders a retryable Alert instead, so a flaky load isn't indistinguishable from
  // "you're not a mod".
  if (!features?.appBlocks) return null;
  if (query.error) {
    if (isModAuthzError(query.error)) return null;
    return (
      <ModQueryError
        error={query.error}
        onRetry={() => query.refetch()}
        isRetrying={query.isFetching}
        title="Couldn’t load listings"
        testId="apps-mod-listings-error"
      />
    );
  }

  const onSort = (column: SortColumn) =>
    setSort((s) => nextSortState(s ?? { column: 'app', direction: 'desc' }, column));
  const onLoadMore = () => {
    setAccumulated(items);
    if (nextCursor) setCursor(nextCursor);
  };

  const openAction = (action: ListingModAction, row: ModerationListingRow) => {
    if (action === 'review') {
      const reviewable = toReviewRow(row);
      // Route to the PAGE-OWNED off-site modal; pass this table's `invalidate` so a
      // successful approve/reject refreshes + resets the table's paging.
      if (reviewable) openOffsiteReview(reviewable, invalidate);
      return;
    }
    if (actionOpensOwnerMessage(action)) {
      setMessageRow(row);
      return;
    }
    // 🔴 BRANCHED ON, not a fall-through. `actionRequiresReason` is the third and last
    // route out of this function, so a future action it answers `false` for opens
    // nothing — loud IN THE TEST AND TYPE TIERS, where a missing route-table property is a
    // `pnpm typecheck` failure and an unrouted action fails the jointly-total sweep. On
    // SCREEN it is a dead button: no toast, no error, no menu close. That is still the
    // better of the two, because a bare `setPendingAction(...)` here is the quiet one: an
    // action with no `reason` of its own lands in the reason-gated modal and calls its
    // proc with an input the schema rejects, the mis-route `message-owner` was carved
    // out of.
    //
    // 🔴 The BRANCH alone did not deliver that, and this comment used to say it did. Both
    // predicates now read a single exhaustive `Record<ListingModAction, …>` route table,
    // so an action absent from it answers `false` to BOTH and reaches nothing; while
    // `actionRequiresReason` was written as a negation, a new union member defaulted to
    // `true` and landed here regardless of how carefully this branch was written.
    if (actionRequiresReason(action)) setPendingAction({ action, row });
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
            // Badge reads the EFFECTIVE status ("Pending" for a draft-with-pending),
            // matching the bucket. Actions below intentionally keep the REAL status.
            const statusChip = listingStatusChip(effectiveModerationStatus(row));
            // Row-shaped so the field mapping and its safe defaults live in a PURE function the
            // unit tier can reach — inline here, nothing could test them (see the 🔴 note on
            // `listingModActionsForRow`).
            const actions = listingModActionsForRow(row);
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
                      // testid so the display-label assertion can select this badge
                      // STRUCTURALLY — a text search for a category word would also
                      // match the app's name or a status chip.
                      <Badge size="sm" variant="light" data-testid="apps-listing-mod-category">
                        {marketplaceCategoryLabel(row.category)}
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
                    {/* The `—` branch is now UNREACHABLE from live data — `Message
                        owner` is offered on every row — and is kept only as the total
                        fallback for an empty action set. Do not read it as evidence
                        that a dead-end row still exists. */}
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
          onChange={onSearchChange}
          testId="apps-mod-listings-filter"
          placeholder="Filter by app name or slug…"
        />
        <Group gap="sm">
          <SegmentedControl
            size="xs"
            value={statusFilter}
            onChange={(v) => onStatusChange(v as StatusFilter)}
            data={STATUS_FILTER_OPTIONS}
            aria-label="Filter by status"
          />
          <SegmentedControl
            size="xs"
            value={kind}
            onChange={(v) => onKindChange(v as KindFilter)}
            data={[
              // 🔴 The `value`s are STORED VALUES and are untouched; only the `label`s
              // resolve from the one source. This control carried BOTH retired words.
              { label: 'All', value: 'all' },
              { label: LISTING_KIND_LABELS.onsite, value: 'onsite' },
              { label: LISTING_KIND_LABELS.offsite, value: 'offsite' },
            ]}
            aria-label="Filter by kind"
          />
        </Group>
      </Group>

      {query.isLoading && items.length === 0 ? (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      ) : totalGroups === 0 && !truncated ? (
        // Genuinely empty ONLY when there's no next page. If a next cursor exists, the
        // current post-filter page can be empty (e.g. a full server page of on-site
        // pending rows filtered out by D) while later pages still hold matching rows —
        // that case must fall through to render Load-more, never this dead end.
        <Card withBorder p="md">
          <Text size="sm" c="dimmed" ta="center" py="sm">
            No listings match the current filters.
          </Text>
        </Card>
      ) : (
        <>
          <Group gap={6}>
            <Text size="xs" c="dimmed" data-testid="apps-mod-listings-count">
              {items.length === 0 && truncated ? (
                <>No matching listings on this page — more exist, Load more to reach them.</>
              ) : (
                <>
                  Showing {items.length}
                  {truncated ? '+ (more listings exist — Load more or narrow the filters)' : ''}.
                </>
              )}
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

      <ListingModActionModal
        pending={pendingAction}
        onClose={() => setPendingAction(null)}
        onDone={invalidate}
      />

      {/* 🔴 NO `onSent={invalidate}`, and that is measured rather than assumed:
          `messageAppOwner` writes an `AppListingModerationEvent` and changes NO listing
          state, and `ModerationListingRow` carries no moderation-event field for the
          new row to differ in. `invalidate` also RESETS PAGING, so refetching here
          would throw away every page the moderator had loaded in exchange for a
          byte-identical result. If this row ever gains a "last moderator action"
          column, wire the callback then. */}
      {/* 🔴 NO OWNER IS PASSED, and the composer's prop shape refuses one. `row.owner`
          is `AppListing.userId`'s denormalised copy; for an on-site listing the proc
          resolves the backing block's owner instead, so handing that copy to a composer
          that presented it as the delivery target would let a moderator address the
          wrong developer. The Owner COLUMN above still shows it — as a column, not as a
          promise about where this message goes. */}
      <MessageAppOwnerModal
        listing={messageRow ? { appListingId: messageRow.id, slug: messageRow.slug } : null}
        onClose={() => setMessageRow(null)}
      />
    </Stack>
  );
}

/**
 * The reason/confirm modal for a single lifecycle action (reset-to-pending / hide /
 * relist / claim / purge). Every action requires a reason (≥{@link
 * OFFSITE_MOD_REASON_MIN} chars, audited); `claim` also needs a numeric target
 * owner id; `purge` is destructive → an extra warning + a typed-slug confirm.
 *
 * The reason field + counter + inline error + disabled-with-Tooltip submit come from
 * the shared {@link ReasonGatedActionModal} (identical UX to the reject paths). Reset
 * routes by kind: an on-site listing calls `resetOnsiteListingToPending` (suspend +
 * re-queue the block review, #3165), an off-site one `resetListingToPending`.
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
  // On-site reset routes through the block-review re-queue proc (#3165).
  const resetOnsiteMut = trpc.appListings.resetOnsiteListingToPending.useMutation({
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
    resetOnsiteMut.isPending ||
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

  function submit() {
    switch (action) {
      case 'reset-to-pending':
        return row.kind === 'onsite'
          ? resetOnsiteMut.mutate({ appListingId: row.id, reason: trimmed })
          : resetMut.mutate({ appListingId: row.id, reason: trimmed });
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
    <ReasonGatedActionModal
      opened={!!pending}
      onCancel={reset}
      busy={busy}
      title={
        <Text fw={600}>
          {listingModActionLabel(action)} — {row.slug}
        </Text>
      }
      reason={reason}
      onReasonChange={setReason}
      reasonLabel={`Reason (≥${OFFSITE_MOD_REASON_MIN} chars, audited)`}
      reasonTestId="apps-mod-action-reason"
      destructive={destructive}
      destructiveWarning={
        <Text size="sm">
          Purge PERMANENTLY deletes this listing and its screenshots + reports, and{' '}
          <b>releases the store address &quot;{row.slug}&quot; for anyone else to claim</b>. The
          audit event (with the slug snapshot) is kept. This cannot be undone.
        </Text>
      }
      confirmSlug={destructive ? row.slug : undefined}
      confirmValue={confirmText}
      onConfirmChange={setConfirmText}
      confirmTestId="apps-mod-purge-confirm"
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
              data-testid="apps-mod-claim-target"
            />
          </>
        ) : undefined
      }
      extraGateSatisfied={!isClaim || validTarget}
      extraGateTooltip="Enter a valid new owner id."
      submitLabel={destructive ? 'Purge permanently' : listingModActionLabel(action)}
      submitTestId="apps-mod-action-confirm"
      onSubmit={submit}
    />
  );
}
