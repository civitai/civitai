import { Alert, Badge, Button, Card, Code, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBox,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconMessage,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { AppAnalyticsInline } from '~/components/Apps/AppAnalyticsInline';
import { isStaleDeploy } from '~/components/Apps/deploy-status';
import {
  bucketGroupsByStatus,
  currentlyPublishedVersionId,
  filterGroups,
  groupSubmissionsByApp,
  sortGroups,
  toDate,
  type SubmissionAccessors,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';
import { StatusSections, SubmissionSearch, VersionToggle } from '~/components/Apps/submissionsTableUi';
import { formatDate } from '~/utils/date-helpers';

export type FileSummary = {
  files?: Array<{ path: string; sha256: string; sizeBytes: number }>;
  added?: string[];
  removed?: string[];
  changed?: string[];
};

export type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

export type Submission = {
  id: string;
  appBlockId: string | null;
  slug: string;
  version: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  /** Phase 2 build/deploy lifecycle for an approved request:
   * 'building' → 'deploying' → 'live', or 'failed'. Null on non-approved rows
   * and on approved rows from before this feature shipped. */
  deployState: 'building' | 'deploying' | 'live' | 'failed' | null;
  deployDetail: string | null;
  deployUpdatedAt: string | Date | null;
  fileSummary: unknown;
  manifestDiffSummary: unknown;
  /** Total pinned subscriptions referencing this app block. */
  modelInstallCount: number | null;
  /** Total BlockUserSubscription rows. */
  userSubscriptionCount: number | null;
};

/** "Month D, YYYY" (e.g. `June 7, 2026`) — the whole-day form used for the
 *  submitted / reviewed timestamps (no hour/minute; those aren't decision-useful
 *  to a submitter). Uses the shared repo date util. */
export function formatSubmissionDate(d: string | Date): string {
  return formatDate(d, 'MMMM D, YYYY');
}

export function statusBadge(
  submission: Pick<Submission, 'status' | 'deployState' | 'deployUpdatedAt'>,
  /** The "live" green badge is reserved for the CURRENTLY-PUBLISHED version (the
   *  newest approved one). A previous approved version — even one whose deploy is
   *  still marked 'live' — shows a plain "approved" badge instead. */
  isCurrentlyPublished: boolean
) {
  const { status } = submission;
  // For an approved request, show the real build/deploy lifecycle rather than a
  // flat "approved" — the dev cares whether their code is actually live.
  if (status === 'approved') {
    if (isStaleDeploy(submission)) {
      return (
        <Badge
          color="orange"
          leftSection={<IconAlertTriangle size={12} />}
          title="No progress for a while — the deploy may be stuck. Resubmit a new version if it doesn't go live."
        >
          {submission.deployState} (stalled)
        </Badge>
      );
    }
    switch (submission.deployState) {
      case 'building':
        return (
          <Badge color="blue" leftSection={<IconClock size={12} />}>
            building
          </Badge>
        );
      case 'deploying':
        return (
          <Badge color="indigo" leftSection={<IconClock size={12} />}>
            deploying
          </Badge>
        );
      case 'failed':
        return (
          <Badge color="red" leftSection={<IconX size={12} />}>
            deploy failed
          </Badge>
        );
      case 'live':
        // Only the currently-published version wears the "live" badge; an older
        // approved version that once deployed shows a plain "approved" instead.
        return (
          <Badge color="green" leftSection={<IconCheck size={12} />}>
            {isCurrentlyPublished ? 'live' : 'approved'}
          </Badge>
        );
      default:
        return (
          <Badge color="green" leftSection={<IconCheck size={12} />}>
            approved
          </Badge>
        );
    }
  }
  switch (status) {
    case 'pending':
      return (
        <Badge color="blue" leftSection={<IconClock size={12} />}>
          pending
        </Badge>
      );
    case 'rejected':
      return (
        <Badge color="red" leftSection={<IconX size={12} />}>
          rejected
        </Badge>
      );
    case 'withdrawn':
      return <Badge color="gray">withdrawn</Badge>;
    default:
      return <Badge color="gray">{status}</Badge>;
  }
}

/**
 * Reviewer notes are no longer rendered inline in the list. Instead an approved
 * (approvalNotes) or rejected (rejectionReason) row gets a "See reviewer notes"
 * button below its status badge that opens the notes in a modal. The button only
 * renders when there are notes to show — a row with no feedback shows nothing.
 */
export function ReviewerNotesButton({
  notes,
  variant,
}: {
  notes: string;
  variant: 'approved' | 'rejected';
}) {
  const [opened, { open, close }] = useDisclosure(false);
  const isRejection = variant === 'rejected';
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        color={isRejection ? 'red' : 'gray'}
        leftSection={<IconMessage size={14} />}
        onClick={open}
      >
        See reviewer notes
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        title={isRejection ? 'Reviewer feedback' : 'Reviewer notes'}
        size="lg"
      >
        <Alert
          color={isRejection ? 'red' : 'green'}
          variant="light"
          icon={isRejection ? <IconX size={16} /> : <IconCheck size={16} />}
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {notes}
          </Text>
        </Alert>
      </Modal>
    </>
  );
}

/**
 * Per-approved-app analytics affordance: a compact inline runs / unique-users
 * (last 30d) stat plus an "Analytics" button that opens the existing
 * AppAnalyticsPanel scoped to this app in a modal. Lives in AppAnalyticsInline
 * so the data fetch is isolated (mockable in tests + only fires for approved
 * rows with an app block).
 */

function StatusCell({
  submission,
  isCurrentlyPublished,
}: {
  submission: Submission;
  isCurrentlyPublished: boolean;
}) {
  const { status, rejectionReason, approvalNotes } = submission;
  const notes =
    status === 'rejected' ? rejectionReason : status === 'approved' ? approvalNotes : null;
  const variant = status === 'rejected' ? 'rejected' : 'approved';
  return (
    <Stack gap={6} align="flex-start">
      {statusBadge(submission, isCurrentlyPublished)}
      {notes && <ReviewerNotesButton notes={notes} variant={variant} />}
    </Stack>
  );
}

/** Field adapters for the shared filter/sort/group helpers. Collapse identity =
 *  the app block id when present (set on first approval), else the slug — so an
 *  app's pre-approval versions (null block id) still group by their shared slug.
 *  Onsite has no display name, so the app label is the slug. */
const ONSITE_ACCESSORS: SubmissionAccessors<Submission> = {
  identity: (s) => s.appBlockId ?? s.slug,
  name: (s) => s.slug,
  slug: (s) => s.slug,
  status: (s) => s.status,
  submittedAt: (s) => toDate(s.submittedAt),
  reviewedAt: (s) => toDate(s.reviewedAt),
};

/** One submission's rows: the main row + (approved) a deploy-failed alert.
 *  `nested` demotes an older (expanded) version row; `isCurrentlyPublished` marks
 *  THIS version as the live one (drives the "live" badge + the "Open live" button
 *  — see {@link currentlyPublishedVersionId}). The "N versions" toggle renders
 *  BELOW the slug, not inline beside it. */
function OnsiteRow({
  s,
  nested,
  isCurrentlyPublished,
  onWithdraw,
  withdrawing,
  toggle,
}: {
  s: Submission;
  nested: boolean;
  isCurrentlyPublished: boolean;
  onWithdraw: (id: string) => void;
  withdrawing: boolean;
  toggle?: ReactNode;
}) {
  const isApproved = s.status === 'approved';
  return (
    <>
      <Table.Tr>
        <Table.Td>
          <Stack gap={4} align="flex-start">
            <Group gap={6} pl={nested ? 'lg' : undefined}>
              {nested && (
                <Text size="xs" c="dimmed">
                  ·
                </Text>
              )}
              <Code>{s.slug}</Code>
            </Group>
            {toggle}
          </Stack>
        </Table.Td>
        <Table.Td>
          <Code>{s.version}</Code>
        </Table.Td>
        <Table.Td>
          <StatusCell submission={s} isCurrentlyPublished={isCurrentlyPublished} />
        </Table.Td>
        <Table.Td>
          <Text size="xs">{formatSubmissionDate(s.submittedAt)}</Text>
        </Table.Td>
        <Table.Td>
          {s.reviewedAt ? (
            <Text size="xs">{formatSubmissionDate(s.reviewedAt)}</Text>
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <InstallCountCell
            modelInstalls={s.modelInstallCount}
            subscriptions={s.userSubscriptionCount}
          />
        </Table.Td>
        <Table.Td>
          {isApproved && s.appBlockId ? (
            <AppAnalyticsInline appBlockId={s.appBlockId} appLabel={s.slug} />
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <SubmissionActions
            submission={s}
            isCurrentlyPublished={isCurrentlyPublished}
            onWithdraw={() => onWithdraw(s.id)}
            busy={withdrawing}
          />
        </Table.Td>
      </Table.Tr>
      {s.status === 'approved' && s.deployState === 'failed' && (
        <Table.Tr>
          <Table.Td colSpan={8} p={0}>
            <Alert
              color="red"
              variant="light"
              radius={0}
              icon={<IconAlertTriangle size={16} />}
              title="Build / deploy failed"
            >
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {s.deployDetail ??
                  'The build or deploy failed. Fix the issue and resubmit a new version.'}
              </Text>
            </Alert>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

export function MySubmissionsList({
  submissions,
  onWithdraw,
  withdrawing,
}: {
  submissions: Submission[];
  onWithdraw: (id: string) => void;
  withdrawing: boolean;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Group by app, apply the text filter, sort newest-first, then partition into
  // status SECTIONS (Live / Pending / Rejected / Withdrawn). Status is now the
  // section, so the column header is no longer sortable — a plain submittedAt-desc
  // sort within each section keeps the newest request on top.
  const buckets = useMemo(() => {
    const grouped = groupSubmissionsByApp(
      submissions,
      ONSITE_ACCESSORS.identity,
      ONSITE_ACCESSORS.submittedAt
    );
    const filtered = filterGroups(grouped, query, ONSITE_ACCESSORS);
    const sorted = sortGroups(
      filtered,
      { column: 'submitted', direction: 'desc' },
      ONSITE_ACCESSORS
    );
    return bucketGroupsByStatus(sorted, ONSITE_ACCESSORS.status);
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

  const renderTable = (groups: SubmissionGroup<Submission>[]) => (
    <Card withBorder p={0}>
      <Table verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Submitted</Table.Th>
            <Table.Th>Reviewed</Table.Th>
            <Table.Th>Installs</Table.Th>
            <Table.Th>Usage (30d)</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {groups.map((g) => {
            const isExpanded = expanded.has(g.identity);
            // Single source of truth for the "live" badge + "Open live" button:
            // the newest approved version across this listing's history.
            const publishedId = currentlyPublishedVersionId([g.latest, ...g.older]);
            return (
              <Fragment key={g.identity}>
                <OnsiteRow
                  s={g.latest}
                  nested={false}
                  isCurrentlyPublished={g.latest.id === publishedId}
                  onWithdraw={onWithdraw}
                  withdrawing={withdrawing}
                  toggle={
                    g.older.length > 0 ? (
                      <VersionToggle
                        expanded={isExpanded}
                        count={g.versionCount}
                        onToggle={() => toggle(g.identity)}
                        variant="subtle"
                        testId={`apps-submissions-versions-${g.identity}`}
                      />
                    ) : undefined
                  }
                />
                {isExpanded &&
                  g.older.map((older) => (
                    <OnsiteRow
                      key={older.id}
                      s={older}
                      nested
                      isCurrentlyPublished={older.id === publishedId}
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
      <SubmissionSearch value={query} onChange={setQuery} testId="apps-submissions-filter" />
      {totalGroups === 0 ? (
        <Card withBorder p="md">
          <Text size="sm" c="dimmed" ta="center" py="sm">
            No submissions match “{query}”.
          </Text>
        </Card>
      ) : (
        <StatusSections
          buckets={buckets}
          testIdPrefix="apps-submissions-section"
          renderTable={renderTable}
        />
      )}
    </Stack>
  );
}

function SubmissionActions({
  submission,
  isCurrentlyPublished,
  onWithdraw,
  busy,
}: {
  submission: Submission;
  isCurrentlyPublished: boolean;
  onWithdraw: () => void;
  busy: boolean;
}) {
  if (submission.status === 'pending') {
    return (
      <Button
        size="xs"
        variant="default"
        color="red"
        onClick={onWithdraw}
        disabled={busy}
        loading={busy}
      >
        Withdraw
      </Button>
    );
  }
  if (submission.status === 'approved') {
    // "Open live" belongs ONLY on the currently-published version AND only when
    // it is actually serving — an older approved version links to nothing live,
    // and a published version still building / with a failed deploy would link to
    // a slug that 404s (and disagree with its "deploy failed"/"building" badge).
    // `null` deployState = legacy/untracked → treated as live (pre-UX-pass behavior).
    const isLiveNow = submission.deployState === 'live' || submission.deployState == null;
    if (!isCurrentlyPublished || !isLiveNow) {
      return (
        <Text size="xs" c="dimmed">
          —
        </Text>
      );
    }
    return (
      <Button
        size="xs"
        variant="default"
        component="a"
        href={`https://${submission.slug}.civit.ai/`}
        target="_blank"
        rel="noopener"
        rightSection={<IconExternalLink size={12} />}
      >
        Open live
      </Button>
    );
  }
  if (submission.status === 'rejected') {
    return (
      <Button
        size="xs"
        component={Link}
        href="/apps/submit"
        rightSection={<IconArrowRight size={12} />}
      >
        Resubmit
      </Button>
    );
  }
  return null;
}

/**
 * Install + subscription count for an approved submission.
 */
function InstallCountCell({
  modelInstalls,
  subscriptions,
}: {
  modelInstalls: number | null;
  subscriptions: number | null;
}) {
  if (modelInstalls == null && subscriptions == null) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Group gap={6}>
      <Badge
        variant="light"
        color="blue"
        size="sm"
        leftSection={<IconBox size={12} />}
        title="Pinned subscriptions — per-model placements"
      >
        {modelInstalls ?? 0}
      </Badge>
      <Badge
        variant="light"
        color="grape"
        size="sm"
        leftSection={<IconUsers size={12} />}
        title="BlockUserSubscription rows — publisher + viewer scopes"
      >
        {subscriptions ?? 0}
      </Badge>
    </Group>
  );
}
