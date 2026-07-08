import { Anchor, Badge, Button, Card, Code, Group, Stack, Table, Text } from '@mantine/core';
import { IconExternalLink, IconPencil } from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  isEditableOffsiteStatus,
  isWithdrawableOffsiteStatus,
  offsiteStatusChip,
} from '~/components/Apps/offsiteSubmissionStatus';
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
  } | null;
  /** True when this parent listing has an in-flight shadow revision under review. */
  hasPendingRevision?: boolean;
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

function StatusCell({ submission }: { submission: OffsiteSubmission }) {
  const chip = offsiteStatusChip(submission.status);
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

function OffsiteRow({
  submission,
  nested,
  onWithdraw,
  withdrawing,
  toggle,
}: {
  submission: OffsiteSubmission;
  /** True for an older (expanded) version row — visually demoted. */
  nested: boolean;
  onWithdraw: (publishRequestId: string) => void;
  withdrawing: boolean;
  /** The "N versions" expand/collapse control (only on a collapsible latest row). */
  toggle?: ReactNode;
}) {
  const s = submission;
  // Edit only on the latest (non-nested) row of an editable request; older
  // versions are historical. Withdraw stays available per-row where applicable.
  const canEdit = !nested && isEditableOffsiteStatus(s.status) && !!s.appListingId;
  const canWithdraw = isWithdrawableOffsiteStatus(s.status);
  const renderActions = () => {
    if (!canEdit && !canWithdraw && !s.hasPendingRevision) {
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
        <StatusCell submission={s} />
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
    </Stack>
  );
}
