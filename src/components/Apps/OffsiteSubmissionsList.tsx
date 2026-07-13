import {
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconHistory,
  IconPencil,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  isEditableOffsiteStatus,
  isWithdrawableOffsiteStatus,
  offsiteStatusChip,
} from '~/components/Apps/offsiteSubmissionStatus';
import {
  canOwnerRepublish,
  canOwnerUnpublish,
  ownerListingState,
  ownerStateChip,
  type OwnerListingState,
} from '~/components/Apps/offsiteOwnerControls';
import {
  OwnerModerationHistoryModal,
  OwnerUnpublishModal,
} from '~/components/Apps/ownerListingModals';
import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';
import { ReviewerNotesButton } from '~/components/Apps/MySubmissionsList';
import {
  bucketGroupsByStatus,
  filterGroups,
  groupSubmissionsByApp,
  sortGroups,
  toDate,
  type SubmissionAccessors,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';
import { StatusSections, SubmissionSearch, VersionToggle } from '~/components/Apps/submissionsTableUi';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/my-submissions — the author's OFF-SITE (external-link) submissions, shown
 * ALONGSIDE the on-site publish-request list (W13 P3a). Kind-aware status chips
 * (pending/approved/rejected/withdrawn), the reviewer-notes modal, an external-URL
 * link, and a Withdraw action for pending rows. Data is
 * `appListings.listMySubmissions` (scoped to the caller server-side).
 *
 * UX pass: a client-side text filter (name/slug), sortable column headers
 * (App/Status/Submitted/Reviewed), and per-app version-collapse (grouped by
 * `slug`, newest shown, older versions expandable). The filter/sort/group logic is
 * the shared pure `submissionsTable.ts` (identical to the onsite list).
 *
 * W13 post-approval management (Phase 3) — OWNER controls on the author's own
 * off-site listings (offsite-only; the procs are offsite-scoped):
 *   - a LIVE (approved) listing → **Unpublish** (confirm-gated; hides it from the
 *     store, no re-review) + the existing shadow-revision **Edit** entry point.
 *   - an owner-unpublished listing → **Republish** (removed → approved).
 *   - a moderator-removed listing → a "removed by a moderator" state (NO republish —
 *     the server FORBIDS self-restore of a takedown) linking to its history.
 *   - a **View history** modal on any live/removed listing showing its
 *     `AppListingModerationEvent` timeline (the owner's "why was this hidden /
 *     un-approved" view).
 * The owner-hidden-vs-mod-removed distinction — which gates Republish — is read from
 * the row's `lastModerationAction` (the list query's projection), NOT a per-row fetch;
 * the server guard remains authoritative (a race surfaces as a mutation error).
 */

export type OffsiteSubmission = {
  id: string;
  appListingId: string | null;
  slug: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  changelog: string | null;
  appListing: {
    name: string | null;
    externalUrl: string | null;
    category: string | null;
    contentRating: string | null;
    /** Non-null only for a shadow revision draft (never surfaced here — inferred). */
    revisionOfId?: string | null;
    /** The listing's TRUE lifecycle status (`draft|pending|approved|rejected|removed`)
     *  — DISTINCT from `status` (the publish-REQUEST status). Drives the owner
     *  unpublish/republish affordances: an owner-hide/mod-delist flips this to
     *  `removed` while the request stays `approved`. */
    status?: string | null;
  } | null;
  /** True when this parent listing has an in-flight shadow revision under review. */
  hasPendingRevision?: boolean;
  /** The listing's most-recent moderation-event action (populated for a `removed`
   *  listing) — `owner-unpublish` ⇒ owner-hidden (republish-eligible), anything else
   *  (a moderator `delist`) ⇒ mod-removed (republish forbidden). */
  lastModerationAction?: string | null;
};

/** Field adapters for the shared filter/sort/group helpers. Collapse identity =
 *  `slug` (the app's unique off-site handle); the filterable/sortable app label
 *  falls back to the slug when a listing has no name. */
const OFFSITE_ACCESSORS: SubmissionAccessors<OffsiteSubmission> = {
  identity: (s) => s.slug,
  name: (s) => s.appListing?.name ?? s.slug,
  slug: (s) => s.slug,
  status: (s) => s.status,
  submittedAt: (s) => toDate(s.submittedAt),
  reviewedAt: (s) => toDate(s.reviewedAt),
};

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

/** Derive the owner-control state for a row's listing (live / owner-hidden /
 *  mod-removed / inactive) from its true listing status + last mod-event action. */
function rowOwnerState(s: OffsiteSubmission): OwnerListingState {
  return ownerListingState({
    listingStatus: s.appListing?.status,
    lastModerationAction: s.lastModerationAction,
  });
}

function StatusCell({
  submission,
  ownerState,
}: {
  submission: OffsiteSubmission;
  ownerState: OwnerListingState;
}) {
  // For a removed listing the request status still reads `approved`, so override the
  // chip with the owner-facing state (unpublished / removed-by-a-moderator).
  const stateChip = ownerStateChip(ownerState);
  const chip = stateChip ?? offsiteStatusChip(submission.status);
  const notes =
    submission.status === 'rejected'
      ? submission.rejectionReason
      : submission.status === 'approved'
      ? submission.approvalNotes
      : null;
  return (
    <Stack gap={6} align="flex-start">
      <Badge color={chip.color}>{chip.label}</Badge>
      {notes && (
        <ReviewerNotesButton
          notes={notes}
          variant={submission.status === 'rejected' ? 'rejected' : 'approved'}
        />
      )}
    </Stack>
  );
}

function LinkCell({ submission }: { submission: OffsiteSubmission }) {
  const url = submission.appListing?.externalUrl;
  if (validateExternalUrl(url).ok) {
    return (
      <Anchor href={url ?? undefined} target="_blank" rel="noopener noreferrer" size="xs">
        <Group gap={4} wrap="nowrap">
          <Text size="xs" lineClamp={1} style={{ maxWidth: 220 }}>
            {url}
          </Text>
          <IconExternalLink size={12} />
        </Group>
      </Anchor>
    );
  }
  if (url) {
    // Present but non-https (defense-in-depth) → INERT text, no anchor.
    return (
      <Text size="xs" c="red" lineClamp={1} style={{ maxWidth: 220 }}>
        {url}
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      —
    </Text>
  );
}

/** Owner-control handlers threaded from the list down to each latest row. */
type OwnerControls = {
  onUnpublish: (listingId: string, slug: string) => void;
  onRepublish: (listingId: string) => void;
  republishing: boolean;
  onViewHistory: (listingId: string, slug: string) => void;
};

function OffsiteRow({
  submission,
  nested,
  onWithdraw,
  withdrawing,
  owner,
  toggle,
}: {
  submission: OffsiteSubmission;
  /** True for an older (expanded) version row — visually demoted. */
  nested: boolean;
  onWithdraw: (publishRequestId: string) => void;
  withdrawing: boolean;
  /** Owner-control handlers (only wired on the latest, non-nested row). */
  owner: OwnerControls;
  /** The "N versions" expand/collapse control (only on a collapsible latest row). */
  toggle?: ReactNode;
}) {
  const s = submission;
  const listingStatus = s.appListing?.status ?? null;
  const ownerState = rowOwnerState(s);
  // Edit only on the latest (non-nested) row of an editable request; older versions
  // are historical, and a REMOVED listing is not editable (the service FORBIDs it),
  // so exclude it here even though its request status is still `approved`.
  const canEdit =
    !nested &&
    isEditableOffsiteStatus(s.status) &&
    !!s.appListingId &&
    listingStatus !== 'removed';
  const canWithdraw = isWithdrawableOffsiteStatus(s.status);
  // Owner takedown affordances live ONLY on the latest row with a real listing id.
  const showOwner = !nested && !!s.appListingId;
  const canUnpublish = showOwner && canOwnerUnpublish(ownerState);
  const canRepublish = showOwner && canOwnerRepublish(ownerState);
  const isModRemoved = showOwner && ownerState === 'mod-removed';
  // History only when there IS history — a removed/hidden listing, or any recorded
  // moderation event. A pristine, never-moderated live listing shows no History button
  // (it would just open to "No moderation history yet.").
  const canViewHistory =
    showOwner &&
    (ownerState === 'owner-hidden' ||
      ownerState === 'mod-removed' ||
      !!s.lastModerationAction);

  const renderActions = () => {
    const hasAny =
      canEdit ||
      canWithdraw ||
      s.hasPendingRevision ||
      canUnpublish ||
      canRepublish ||
      isModRemoved ||
      canViewHistory;
    if (!hasAny) {
      return (
        <Text size="xs" c="dimmed">
          —
        </Text>
      );
    }
    return (
      <Group gap={6} wrap="nowrap">
        {canEdit && s.appListingId && (
          <Button
            size="xs"
            variant="default"
            component={Link}
            href={`/apps/submit?edit=${encodeURIComponent(s.appListingId)}`}
            leftSection={<IconPencil size={12} />}
            data-testid={`apps-offsite-edit-${s.slug}`}
          >
            Edit
          </Button>
        )}
        {canUnpublish && s.appListingId && (
          <Button
            size="xs"
            variant="default"
            color="orange"
            onClick={() => owner.onUnpublish(s.appListingId as string, s.slug)}
            leftSection={<IconEyeOff size={12} />}
            data-testid={`apps-offsite-unpublish-${s.slug}`}
          >
            Unpublish
          </Button>
        )}
        {canRepublish && s.appListingId && (
          <Button
            size="xs"
            variant="default"
            color="green"
            onClick={() => owner.onRepublish(s.appListingId as string)}
            disabled={owner.republishing}
            loading={owner.republishing}
            leftSection={<IconEye size={12} />}
            data-testid={`apps-offsite-republish-${s.slug}`}
          >
            Republish
          </Button>
        )}
        {isModRemoved && (
          <Text size="xs" c="red" data-testid={`apps-offsite-mod-removed-${s.slug}`}>
            Removed by a moderator
          </Text>
        )}
        {canWithdraw && (
          <Button
            size="xs"
            variant="default"
            color="red"
            onClick={() => onWithdraw(s.id)}
            disabled={withdrawing}
            loading={withdrawing}
            data-testid={`apps-offsite-withdraw-${s.slug}`}
          >
            Withdraw
          </Button>
        )}
        {canViewHistory && s.appListingId && (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => owner.onViewHistory(s.appListingId as string, s.slug)}
            leftSection={<IconHistory size={12} />}
            data-testid={`apps-offsite-history-${s.slug}`}
          >
            History
          </Button>
        )}
        {s.hasPendingRevision && (
          <Badge
            size="xs"
            color="orange"
            variant="light"
            data-testid={`apps-offsite-revision-pending-${s.slug}`}
          >
            revision in review
          </Badge>
        )}
      </Group>
    );
  };
  return (
    <Table.Tr data-testid={`apps-offsite-submission-row-${s.slug}`}>
      <Table.Td>
        <Group gap={6} pl={nested ? 'lg' : undefined}>
          {nested && (
            <Text size="xs" c="dimmed">
              ·
            </Text>
          )}
          <Code>{s.slug}</Code>
          {!nested && (
            <Badge size="xs" color="grape" variant="light">
              external
            </Badge>
          )}
          {toggle}
        </Group>
        {!nested && s.appListing?.name && (
          <Text size="xs" c="dimmed">
            {s.appListing.name}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <LinkCell submission={s} />
      </Table.Td>
      <Table.Td>
        <StatusCell submission={s} ownerState={nested ? 'inactive' : ownerState} />
      </Table.Td>
      <Table.Td>
        <Text size="xs">{formatDate(s.submittedAt)}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs" c={s.reviewedAt ? undefined : 'dimmed'}>
          {formatDate(s.reviewedAt)}
        </Text>
      </Table.Td>
      <Table.Td>{renderActions()}</Table.Td>
    </Table.Tr>
  );
}

export function OffsiteSubmissionsList({
  submissions,
  onWithdraw,
  withdrawing,
}: {
  submissions: OffsiteSubmission[];
  onWithdraw: (publishRequestId: string) => void;
  withdrawing: boolean;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [unpublishTarget, setUnpublishTarget] = useState<{ id: string; slug: string } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; slug: string } | null>(null);

  const utils = trpc.useUtils();
  const invalidateSubmissions = () => utils.appListings.listMySubmissions.invalidate();

  const republishMutation = trpc.appListings.republishOwnListing.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'App republished — it is live in the store again.' });
      await invalidateSubmissions();
    },
    onError: (e) => showErrorNotification({ title: 'Republish failed', error: new Error(e.message) }),
  });

  const owner: OwnerControls = {
    onUnpublish: (id, slug) => setUnpublishTarget({ id, slug }),
    onRepublish: (id) => republishMutation.mutate({ appListingId: id }),
    republishing: republishMutation.isPending,
    onViewHistory: (id, slug) => setHistoryTarget({ id, slug }),
  };

  // Group → filter → sort newest-first → partition into status SECTIONS. Status is
  // now the section (Live / Pending / Rejected / Withdrawn), so the header column is
  // no longer sortable; a plain submittedAt-desc sort orders rows within a section.
  const buckets = useMemo(() => {
    const grouped = groupSubmissionsByApp(
      submissions,
      OFFSITE_ACCESSORS.identity,
      OFFSITE_ACCESSORS.submittedAt
    );
    const filtered = filterGroups(grouped, query, OFFSITE_ACCESSORS);
    const sorted = sortGroups(
      filtered,
      { column: 'submitted', direction: 'desc' },
      OFFSITE_ACCESSORS
    );
    return bucketGroupsByStatus(sorted, OFFSITE_ACCESSORS.status);
  }, [submissions, query]);

  const totalGroups =
    buckets.live.length +
    buckets.pending.length +
    buckets.rejected.length +
    buckets.withdrawn.length;

  const toggle = (identity: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });

  const renderTable = (groups: SubmissionGroup<OffsiteSubmission>[]) => (
    <Card withBorder p={0}>
      <Table verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Link</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Submitted</Table.Th>
            <Table.Th>Reviewed</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {groups.map((g) => {
            const isExpanded = expanded.has(g.identity);
            return (
              <Fragment key={g.identity}>
                <OffsiteRow
                  submission={g.latest}
                  nested={false}
                  onWithdraw={onWithdraw}
                  withdrawing={withdrawing}
                  owner={owner}
                  toggle={
                    g.older.length > 0 ? (
                      <VersionToggle
                        expanded={isExpanded}
                        count={g.versionCount}
                        onToggle={() => toggle(g.identity)}
                        testId={`apps-offsite-versions-${g.identity}`}
                      />
                    ) : undefined
                  }
                />
                {isExpanded &&
                  g.older.map((older) => (
                    <OffsiteRow
                      key={older.id}
                      submission={older}
                      nested
                      onWithdraw={onWithdraw}
                      withdrawing={withdrawing}
                      owner={owner}
                    />
                  ))}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Card>
  );

  return (
    <Stack gap="md">
      <SubmissionSearch
        value={query}
        onChange={setQuery}
        testId="apps-offsite-submissions-filter"
      />
      {totalGroups === 0 ? (
        <Card withBorder p="md">
          <Text size="sm" c="dimmed" ta="center" py="sm">
            No submissions match “{query}”.
          </Text>
        </Card>
      ) : (
        <StatusSections
          buckets={buckets}
          testIdPrefix="apps-offsite-submissions-section"
          renderTable={renderTable}
        />
      )}

      <OwnerUnpublishModal
        target={unpublishTarget}
        onClose={() => setUnpublishTarget(null)}
        onDone={invalidateSubmissions}
        testIdPrefix="apps-offsite"
        variant="store"
      />
      <OwnerModerationHistoryModal
        target={historyTarget}
        onClose={() => setHistoryTarget(null)}
        testIdPrefix="apps-offsite"
      />
    </Stack>
  );
}
