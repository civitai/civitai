import { Alert, Badge, Button, Card, Code, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBox,
  IconCheck,
  IconClock,
  IconCoin,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconHistory,
  IconMessage,
  IconPencil,
  IconPhoto,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { AppAnalyticsInline } from '~/components/Apps/AppAnalyticsInline';
import {
  ListingProblemsIndicator,
  type ListingProblem,
} from '~/components/Apps/ListingProblemsIndicator';
import { getDetailPrimaryAction } from '~/components/Apps/appListingDetailView';
import { isStaleDeploy, isStrandedDeploy } from '~/components/Apps/deploy-status';
import {
  canOwnerRepublish,
  canOwnerUnpublish,
  isModRemovedListing,
  ownerListingState,
  ownerStateChip,
  type OwnerListingState,
} from '~/components/Apps/offsiteOwnerControls';
import {
  OwnerModerationHistoryModal,
  OwnerUnpublishModal,
} from '~/components/Apps/ownerListingModals';
import {
  bucketGroupsByStatus,
  currentlyPublishedVersionId,
  filterGroups,
  groupSubmissionsByApp,
  OWNER_STATUS_BUCKETS,
  sortGroups,
  SUBMISSIONS_TABLE_MIN_WIDTH,
  toDate,
  type SubmissionAccessors,
  type SubmissionGroup,
} from '~/components/Apps/submissionsTable';
import { StatusSections, SubmissionSearch, VersionToggle } from '~/components/Apps/submissionsTableUi';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

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
  /** W13 P4 owner controls — the backing on-site `AppListing.id` (the target for
   *  unpublish/republish/history). Null when no listing row exists yet (a pending
   *  first version, or a pre-W13 backfill gap). */
  appListingId?: string | null;
  /** The backing `AppListing`'s TRUE lifecycle status
   *  (`draft|pending|approved|rejected|removed`) — DISTINCT from `status` (the
   *  publish-REQUEST status). An owner unpublish flips this to `removed` while the
   *  request stays `approved`, so it drives the live/hidden/removed owner state. Null
   *  when there's no backing listing. */
  listingStatus?: string | null;
  /** The backing listing's most-recent moderation-event action (populated for a
   *  `removed` listing) — `owner-unpublish` ⇒ owner-hidden (Republish-eligible),
   *  anything else (a moderator `delist`/`purge`) ⇒ mod-removed (Republish forbidden). */
  lastModerationAction?: string | null;
  /** Whether the backing block's manifest declares a launchable page — drives the
   *  Open-live → `/apps/run/<slug>` vs standalone-origin vs model-slot branching. */
  hasPage?: boolean | null;
  /** Advisory listing-completeness problems (missing assets + empty key fields),
   *  from the server's `computeListingProblems`. Empty ⇒ no warning icon. */
  problems?: ListingProblem[];
};

/** Owner-control handlers threaded from the list down to each latest row. */
type OnsiteOwnerControls = {
  onUnpublish: (listingId: string, slug: string) => void;
  onRepublish: (listingId: string) => void;
  republishing: boolean;
  onViewHistory: (listingId: string, slug: string) => void;
};

/** Derive the owner-control state (live / owner-hidden / mod-removed / inactive) for a
 *  row from its TRUE backing-listing status + last moderation-event action. */
function rowOwnerState(s: Submission): OwnerListingState {
  return ownerListingState({
    listingStatus: s.listingStatus,
    lastModerationAction: s.lastModerationAction,
  });
}

/** "Month D, YYYY" (e.g. `June 7, 2026`) — the whole-day form used for the
 *  submitted / reviewed timestamps (no hour/minute; those aren't decision-useful
 *  to a submitter). Uses the shared repo date util. */
export function formatSubmissionDate(d: string | Date): string {
  return formatDate(d, 'MMMM D, YYYY');
}

/** Copy for the STRANDED state, shared by the badge tooltip and the row alert so
 *  the two can never drift. The author cannot fix this themselves — the approval
 *  is durable and only a moderator can re-fire the build — so the guidance is to
 *  ask, NOT to resubmit at a new version. */
export const STRANDED_DEPLOY_MESSAGE =
  'This version was approved but its build never started, so the code was never deployed. ' +
  'This is not something you can fix by editing your app — contact a moderator to re-run the build.';

export function statusBadge(
  submission: Pick<Submission, 'status' | 'deployState' | 'deployUpdatedAt' | 'reviewedAt'>,
  /** The "live" green badge is reserved for the CURRENTLY-PUBLISHED version (the
   *  newest approved one). A previous approved version — even one whose deploy is
   *  still marked 'live' — shows a plain "approved" badge instead. */
  isCurrentlyPublished: boolean
) {
  const { status } = submission;
  // For an approved request, show the real build/deploy lifecycle rather than a
  // flat "approved" — the dev cares whether their code is actually live.
  if (status === 'approved') {
    // STRANDED — approved long ago, but the build never started so `deployState`
    // was never written. Checked BEFORE the switch, whose `default` branch would
    // otherwise render a healthy green "approved" for exactly this case.
    // `isStrandedDeploy` only fires past DEPLOY_STALE_AFTER_MS with no recorded
    // transition, so a freshly-approved row (and every pre-feature legacy row
    // that ever transitioned) is untouched.
    if (isStrandedDeploy(submission)) {
      return (
        <Badge
          color="orange"
          leftSection={<IconAlertTriangle size={12} />}
          title={STRANDED_DEPLOY_MESSAGE}
        >
          build never started
        </Badge>
      );
    }
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
  ownerState,
}: {
  submission: Submission;
  isCurrentlyPublished: boolean;
  /** Owner-facing state; when owner-hidden / mod-removed it OVERRIDES the badge (the
   *  publish request still reads `approved`, which would misleadingly show "live"). */
  ownerState: OwnerListingState;
}) {
  const { status, rejectionReason, approvalNotes } = submission;
  const notes =
    status === 'rejected' ? rejectionReason : status === 'approved' ? approvalNotes : null;
  const variant = status === 'rejected' ? 'rejected' : 'approved';
  // A removed backing listing (owner-hidden / mod-removed) overrides the deploy/request
  // badge with the owner-facing state; live/inactive keep the normal badge.
  const override = ownerStateChip(ownerState);
  const chip = override ? (
    <Badge color={override.color}>{override.label}</Badge>
  ) : (
    statusBadge(submission, isCurrentlyPublished)
  );
  return (
    <Stack gap={6} align="flex-start">
      <Group gap={6} wrap="nowrap">
        {chip}
        <ListingProblemsIndicator problems={submission.problems ?? []} />
      </Group>
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
  owner,
  canOpenPage,
  toggle,
}: {
  s: Submission;
  nested: boolean;
  isCurrentlyPublished: boolean;
  onWithdraw: (id: string) => void;
  withdrawing: boolean;
  /** Owner-control handlers (wired only on the latest, non-nested row). */
  owner: OnsiteOwnerControls;
  /** Mirrors the `appBlocksPages` flag — gates the /apps/run/<slug> Open link. */
  canOpenPage: boolean;
  toggle?: ReactNode;
}) {
  const isApproved = s.status === 'approved';
  // Owner state lives on the latest (non-nested) row only; older versions are history.
  const ownerState = nested ? ('inactive' as OwnerListingState) : rowOwnerState(s);
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
          <StatusCell
            submission={s}
            isCurrentlyPublished={isCurrentlyPublished}
            ownerState={ownerState}
          />
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
            nested={nested}
            ownerState={ownerState}
            owner={owner}
            canOpenPage={canOpenPage}
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
              <DeployFailureDetail detail={s.deployDetail} slug={s.slug} />
            </Alert>
          </Table.Td>
        </Table.Tr>
      )}
      {s.status === 'approved' && isStrandedDeploy(s) && (
        <Table.Tr>
          <Table.Td colSpan={8} p={0}>
            <Alert
              color="orange"
              variant="light"
              radius={0}
              icon={<IconAlertTriangle size={16} />}
              title="Approved, but the build never started"
              data-testid={`apps-submissions-stranded-${s.slug}`}
            >
              <Text size="sm">{STRANDED_DEPLOY_MESSAGE}</Text>
            </Alert>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

/**
 * The build/deploy failure body shown to the APP AUTHOR.
 *
 * `deployDetail` is now `"Build <status>"` plus, when the pipeline sent one, a
 * blank line and a sanitized excerpt of the real build log — the line that
 * actually tells the author what to fix ("no package-lock.json is committed…").
 * Before this, that line existed only in a build log they cannot read.
 *
 * RENDERING SAFETY — the excerpt originates from tenant-influenced build output.
 * It is sanitized server-side to printable text + newlines
 * (`sanitizeBuildFailureReason`) AND rendered here through ordinary React text
 * interpolation, which escapes. There is deliberately no `dangerouslySetInnerHTML`
 * anywhere on this path, so even a hostile excerpt renders as literal characters.
 *
 * LAYOUT — the excerpt is capped at ~14rem of scrollable height and scrolls on
 * BOTH axes inside its own box, so a multi-KB stack trace or a very long line can
 * never blow out the table row or push the page into horizontal scroll.
 */
function DeployFailureDetail({ detail, slug }: { detail: string | null; slug: string }) {
  const fallback = 'The build or deploy failed. Fix the issue and resubmit a new version.';
  if (!detail) {
    return <Text size="sm">{fallback}</Text>;
  }
  // Split the "Build <status>" headline from the log excerpt (the server joins
  // them with a blank line). No excerpt → the headline is the whole message and
  // renders exactly as it did before this feature.
  const separator = detail.indexOf('\n\n');
  const headline = separator === -1 ? detail : detail.slice(0, separator);
  const excerpt = separator === -1 ? null : detail.slice(separator + 2);
  return (
    <Stack gap={6}>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {headline}
      </Text>
      {excerpt && (
        // A plain <pre> rather than Mantine's <Code block>: the excerpt needs
        // `pre-wrap` + a hard height cap, and owning the styles outright keeps
        // that guarantee independent of the component library's own CSS.
        <pre
          data-testid={`apps-submissions-failure-detail-${slug}`}
          style={{
            margin: 0,
            padding: '0.5rem 0.65rem',
            borderRadius: 4,
            fontSize: '0.75rem',
            lineHeight: 1.45,
            fontFamily: 'var(--mantine-font-family-monospace, monospace)',
            background: 'var(--mantine-color-default, rgba(0,0,0,0.06))',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxHeight: '14rem',
            overflow: 'auto',
          }}
        >
          {excerpt}
        </pre>
      )}
    </Stack>
  );
}

export function MySubmissionsList({
  submissions,
  onWithdraw,
  withdrawing,
  canOpenPage = false,
}: {
  submissions: Submission[];
  onWithdraw: (id: string) => void;
  withdrawing: boolean;
  /** Mirrors the viewer's `appBlocksPages` flag — an on-site page app only routes to
   *  the /apps/run/<slug> in-host page when this is true; otherwise the Open-live
   *  falls back to the standalone origin (never a dead run link). */
  canOpenPage?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [unpublishTarget, setUnpublishTarget] = useState<{ id: string; slug: string } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; slug: string } | null>(null);

  const utils = trpc.useUtils();
  const invalidateSubmissions = () => utils.blocks.listMyPublishRequests.invalidate();

  const republishMutation = trpc.appListings.republishOwnListing.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'App republished — it is live again.' });
      await invalidateSubmissions();
    },
    onError: (e) => showErrorNotification({ title: 'Republish failed', error: new Error(e.message) }),
  });

  const owner: OnsiteOwnerControls = {
    onUnpublish: (id, slug) => setUnpublishTarget({ id, slug }),
    onRepublish: (id) => republishMutation.mutate({ appListingId: id }),
    republishing: republishMutation.isPending,
    onViewHistory: (id, slug) => setHistoryTarget({ id, slug }),
  };

  // Group by app, apply the text filter, sort newest-first, then partition into
  // status SECTIONS (Live / Pending / Rejected / Withdrawn / Removed-by-a-moderator).
  // Status is now the section, so the column header is no longer sortable — a plain
  // submittedAt-desc sort within each section keeps the newest request on top. The
  // `overrideBucketOf` routes a moderator-removed listing into its own collapsed
  // section, taking precedence over the any-approved→Live rule (a once-live app a mod
  // took down would otherwise misfile under Live).
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
    return bucketGroupsByStatus(sorted, ONSITE_ACCESSORS.status, OWNER_STATUS_BUCKETS, (g) =>
      // INVARIANT: the backing-listing fields (`listingStatus` + `lastModerationAction`)
      // are keyed per APP (the single `AppListing`), not per version — the server
      // projects the same values onto every publish-request row in the group — so
      // reading them off `g.latest` is equivalent to reading them off any version.
      isModRemovedListing({
        listingStatus: g.latest.listingStatus,
        lastModerationAction: g.latest.lastModerationAction,
      })
        ? 'mod-removed'
        : null
    );
  }, [submissions, query]);

  const totalGroups =
    buckets.live.length +
    buckets.pending.length +
    buckets.rejected.length +
    buckets.withdrawn.length +
    buckets['mod-removed'].length;

  const toggle = (identity: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });

  const renderTable = (groups: SubmissionGroup<Submission>[]) => (
    <Card withBorder p={0}>
      {/*
        `.mantine-Card-root` is `overflow: hidden`, and this row's action cell is a
        `wrap="nowrap"` group of up to six buttons — so without a scroll container the
        card silently CLIPS the actions (measured: 138 px cut at a 1497 px viewport,
        no scrollbar). `type="native"` deliberately, not Mantine's default ScrollArea:
        ScrollArea defaults to `type="hover"` (scrollbars hidden until hover), and the
        whole defect is a MISSING affordance. A native `overflow-x: auto` box shows the
        platform scrollbar and keeps native keyboard/trackpad scrolling.
      */}
      <Table.ScrollContainer
        minWidth={SUBMISSIONS_TABLE_MIN_WIDTH}
        type="native"
        data-testid="apps-submissions-table-scroll"
      >
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
                    owner={owner}
                    canOpenPage={canOpenPage}
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
                        owner={owner}
                        canOpenPage={canOpenPage}
                      />
                    ))}
                </Fragment>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
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

      <OwnerUnpublishModal
        target={unpublishTarget}
        onClose={() => setUnpublishTarget(null)}
        onDone={invalidateSubmissions}
        testIdPrefix="apps-onsite"
        variant="offline"
      />
      <OwnerModerationHistoryModal
        target={historyTarget}
        onClose={() => setHistoryTarget(null)}
        testIdPrefix="apps-onsite"
      />
    </Stack>
  );
}

/**
 * The primary "open the running app" affordance for an APPROVED, currently-published,
 * serving on-site app — graceful, never a dead link. Reuses the shared
 * {@link getDetailPrimaryAction} matrix (identical to the store detail):
 *   - page app + canOpenPage → **Open** → `/apps/run/<slug>` (internal in-host page).
 *   - page app + !canOpenPage → **Open live** → the standalone `<slug>.civit.ai` origin.
 *   - model-slot app (no page) → informational "Runs on model pages" → the block detail.
 */
function OpenLiveAction({
  submission,
  canOpenPage,
}: {
  submission: Submission;
  canOpenPage: boolean;
}) {
  const action = getDetailPrimaryAction(
    {
      slug: submission.slug,
      kind: 'onsite',
      kindData: {
        kind: 'onsite',
        appBlockId: submission.appBlockId ?? null,
        hasPage: !!submission.hasPage,
        // The already-public standalone origin (the pre-P4 hardcoded target).
        liveUrl: `https://${submission.slug}.civit.ai/`,
      },
    },
    { canOpenPage }
  );
  const testId = `apps-submissions-open-${submission.slug}`;
  if (action.mode === 'open') {
    return (
      <Button
        size="xs"
        variant="default"
        component={Link}
        href={action.href ?? '#'}
        rightSection={<IconArrowRight size={12} />}
        data-testid={testId}
      >
        {action.label}
      </Button>
    );
  }
  if (action.mode === 'visit' && action.href) {
    return (
      <Button
        size="xs"
        variant="default"
        component="a"
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        rightSection={<IconExternalLink size={12} />}
        data-testid={testId}
      >
        {action.label}
      </Button>
    );
  }
  // Model-slot / no launchable page → informational; links to the block detail where
  // the install affordance lives, never a dead standalone link.
  if (action.href) {
    return (
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        component={Link}
        href={action.href}
        data-testid={testId}
      >
        {action.label}
      </Button>
    );
  }
  return (
    <Text size="xs" c="dimmed" data-testid={testId}>
      {action.label}
    </Text>
  );
}

function SubmissionActions({
  submission,
  isCurrentlyPublished,
  onWithdraw,
  busy,
  nested,
  ownerState,
  owner,
  canOpenPage,
}: {
  submission: Submission;
  isCurrentlyPublished: boolean;
  onWithdraw: () => void;
  busy: boolean;
  nested: boolean;
  ownerState: OwnerListingState;
  owner: OnsiteOwnerControls;
  canOpenPage: boolean;
}) {
  const s = submission;
  if (s.status === 'pending') {
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
  if (s.status === 'approved') {
    // A removed backing listing (owner-hidden / mod-removed) is NOT serving — never
    // offer an Open affordance for it. `null` deployState = legacy/untracked → live.
    const isRemoved = ownerState === 'owner-hidden' || ownerState === 'mod-removed';
    const isLiveNow = s.deployState === 'live' || s.deployState == null;
    const showOpen = isCurrentlyPublished && isLiveNow && !isRemoved;

    // Owner takedown affordances live ONLY on the latest (non-nested) row with a
    // backing listing id (unpublish/republish/history all target the AppListing).
    const showOwner = !nested && !!s.appListingId;
    const listingId = s.appListingId as string;
    const canUnpublish = showOwner && canOwnerUnpublish(ownerState);
    const canRepublish = showOwner && canOwnerRepublish(ownerState);
    const isModRemoved = showOwner && ownerState === 'mod-removed';
    // History only when there IS history — a removed/hidden listing, or any recorded
    // moderation event. A pristine, never-moderated live app shows no History button
    // (it would just open to "No moderation history yet.").
    const canViewHistory =
      showOwner &&
      (ownerState === 'owner-hidden' ||
        ownerState === 'mod-removed' ||
        !!s.lastModerationAction);
    // Surface the manage entry points on any live / owner-hidden app (an app the owner
    // still controls); a mod takedown hides Edit (mirrors the off-site list), Revenue
    // stays (earnings are historical + viewable regardless of visibility).
    const canManage = showOwner && s.appBlockId;
    const showEdit = canManage && ownerState !== 'mod-removed';

    const hasAny =
      showOpen ||
      canUnpublish ||
      canRepublish ||
      isModRemoved ||
      canViewHistory ||
      canManage;
    if (!hasAny) {
      return (
        <Text size="xs" c="dimmed">
          —
        </Text>
      );
    }
    return (
      <Group gap={6} wrap="nowrap">
        {showOpen && <OpenLiveAction submission={s} canOpenPage={canOpenPage} />}
        {canUnpublish && (
          <Button
            size="xs"
            variant="default"
            color="orange"
            onClick={() => owner.onUnpublish(listingId, s.slug)}
            leftSection={<IconEyeOff size={12} />}
            data-testid={`apps-onsite-unpublish-${s.slug}`}
          >
            Unpublish
          </Button>
        )}
        {canRepublish && (
          <Button
            size="xs"
            variant="default"
            color="green"
            onClick={() => owner.onRepublish(listingId)}
            disabled={owner.republishing}
            loading={owner.republishing}
            leftSection={<IconEye size={12} />}
            data-testid={`apps-onsite-republish-${s.slug}`}
          >
            Republish
          </Button>
        )}
        {isModRemoved && (
          <Text size="xs" c="red" data-testid={`apps-onsite-mod-removed-${s.slug}`}>
            Removed by a moderator
          </Text>
        )}
        {showEdit && s.appBlockId && (
          <Button
            size="xs"
            variant="default"
            component={Link}
            href={`/apps/${encodeURIComponent(s.appBlockId)}/edit`}
            leftSection={<IconPencil size={12} />}
            data-testid={`apps-onsite-edit-${s.slug}`}
          >
            Edit
          </Button>
        )}
        {showEdit && s.appBlockId && (
          <Button
            size="xs"
            variant="default"
            component={Link}
            href={`/apps/${encodeURIComponent(s.appBlockId)}/edit?tab=media`}
            leftSection={<IconPhoto size={12} />}
            data-testid={`apps-onsite-listing-media-${s.slug}`}
          >
            Listing images
          </Button>
        )}
        {canManage && s.appBlockId && (
          <Button
            size="xs"
            variant="default"
            component={Link}
            href={`/apps/${encodeURIComponent(s.appBlockId)}/revenue`}
            leftSection={<IconCoin size={12} />}
            data-testid={`apps-onsite-revenue-${s.slug}`}
          >
            Revenue
          </Button>
        )}
        {canViewHistory && (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => owner.onViewHistory(listingId, s.slug)}
            leftSection={<IconHistory size={12} />}
            data-testid={`apps-onsite-history-${s.slug}`}
          >
            History
          </Button>
        )}
      </Group>
    );
  }
  if (s.status === 'rejected') {
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
