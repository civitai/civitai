import { Alert, Badge, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { DeployFailureDetail } from '~/components/Apps/DeployFailureDetail';
import {
  deployElapsedMs,
  deployRefetchInterval,
  formatElapsed,
  isInFlightDeploy,
  isStaleDeploy,
  isStrandedDeploy,
  type DeployLifecycleState,
} from '~/components/Apps/deploy-status';
import { deployStatusBadge, STRANDED_DEPLOY_MESSAGE } from '~/components/Apps/deployStatusBadge';
import { withdrawSuccessMessage } from '~/components/Apps/listingPublishingActions';
import { historyStatusColor } from '~/components/Apps/myAppsView';
import { currentlyPublishedVersionId } from '~/components/Apps/submissionsTable';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BuildAttemptSignals } from '~/shared/constants/app-block-build.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The authoring page's **History** tab — one listing's full publish-request stream.
 *
 * 🔴 IT MOVED HERE FROM `/apps/mine`, IT WAS NOT COPIED. The row-level disclosure toggle
 * and its panel are gone from that table. Two homes for one record is how the two come to
 * disagree about what a status means, and the row was the wrong home anyway: a publish
 * request is an EVENT on an app, and the app's own authoring page is where its events
 * belong. The row's link now lands on the tab that exists (`myAppListingHref` derives it
 * from `editorTabsFor`), so nothing about the move strands an author.
 *
 * 🔴 THE POPULATION THAT MOVING IT COULD HAVE STRANDED, AND WHY IT DOES NOT. An author
 * arriving from a rejection notification lands on `/apps/mine`. Two shapes reach it:
 *
 *   - a REMOVED listing — its history used to be reachable only from the row, and
 *     `/apps/mine` deliberately did NOT link those rows to the editor because the authoring
 *     page refused the status. Both halves changed together: the route now opens on it in a
 *     narrowed mode whose tab set is at most Publishing, History, Feedback, and the row links to it.
 *     Had only the panel moved, that population would have lost its history entirely —
 *     which is why the route change and this move are one PR.
 *
 *     🔴 `rejected` IS **NOT** A SECOND SUCH POPULATION, and an earlier draft of this
 *     comment said it was. Measured across all 33 `appListing` write sites: nothing writes
 *     `AppListing.status = 'rejected'`. An on-site reject DELETES the pre-approval draft
 *     listing (releasing the slug) and an off-site reject writes `removed` via
 *     `closeTerminalListing`; the two `status:'rejected'` writes in the tree are both on the
 *     publish-REQUEST tables, which are a different column entirely. So the `rejected`
 *     branch is a FAIL-SAFE for a value the DB CHECK permits and legacy rows may carry — it
 *     is right to keep and right to test, but it serves nobody today, and describing it as a
 *     stranded population overstates what this move rescues. The authors of rejected first
 *     versions are served by the orphan group, which stays on `/apps/mine` untouched.
 *   - a submission whose LISTING WAS DELETED (a first version rejected or withdrawn
 *     releases the slug). That population has no listing and therefore no authoring page at
 *     all; it is served by the "Submissions without a listing" group, which STAYS on
 *     `/apps/mine` untouched. Moving it here would have been the strand.
 *
 * 🔴 BOTH ROLES, EVERY STATUS. `appListings.listingHistory` authorizes through
 * `resolveListingAccess` — the owner OR an accepted seat — and reads no status at all, so
 * it refuses nothing this page can reach. That is deliberate parity with `/apps/mine`,
 * where a seated collaborator could always open a row's history.
 *
 * 🔴 THIS IS ALSO WHERE AN APP'S TEAM LEARNS WHETHER AN APPROVED VERSION WENT LIVE. An
 * approved version entry carries its build/deploy chip, elapsed time while it builds, and
 * — when it failed — the cause, the guidance and the build-log excerpt
 * (`DeployFailureDetail`). Collaborators see the excerpt too: same access rule as above,
 * same code. That block lives in {@link ListingHistoryPanelView}, NOT in
 * {@link ListingHistoryEntryRow}, because the row is shared with the moderator's
 * prior-versions modal and moderators never see the excerpt.
 */

/** One entry from `appListings.listingHistory` — see that service for the two streams. */
export type ListingHistoryEntry = {
  id: string;
  source: 'version' | 'listing';
  status: string;
  version: string | null;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  changelog: string | null;
  deployState: string | null;
  /** Last lifecycle transition — the clock for elapsed time and the stalled check. */
  deployUpdatedAt?: string | Date | null;
  /**
   * The failure detail, sent by the server only for an approved version whose deploy
   * failed (`authorFailureDetail`). Optional because the moderator projection never
   * carries it.
   */
  deployDetail?: string | null;
  /**
   * The latest build attempt's failed step and class, sent with `deployDetail` (same
   * approved + failed rule). Structured values only.
   */
  buildSignals?: BuildAttemptSignals | null;
  /**
   * The SERVER's verdict on whether this caller may withdraw this request. Both withdraw
   * procs are submitter-scoped, so a collaborator / transfer recipient / mod-claimed owner
   * offered the button gets a guaranteed red toast. Optional on the type only so a fixture
   * need not spell it; treated as `false` when absent, which is the safe direction.
   */
  canWithdraw?: boolean;
};

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return formatDate(value, 'MMM D, YYYY');
}

export type ListingHistoryPanelViewProps = {
  entries: ListingHistoryEntry[];
  loading?: boolean;
  errorMessage?: string | null;
  onWithdraw?: (entry: ListingHistoryEntry) => void;
  withdrawing?: boolean;
  /**
   * Is the VERSION-withdraw mutation reachable for this viewer? The container passes
   * `features.appBlocks`, because `blocks.withdrawPublishRequest` carries
   * `enforceAppBlocksFlag` while this page does not. Listing-source entries are unaffected
   * — `appListings.withdrawExternalRequest` has no such gate.
   */
  withdrawEnabled?: boolean;
  /** Pins the clock for tests. When absent the view ticks once a second while a build runs. */
  now?: number;
};

/**
 * The usual wall time of a whole build + deploy. Shown only while `building`: the elapsed
 * clock restarts at each state transition, so beside `deploying` it would undercount.
 */
export const TYPICAL_BUILD_HINT = 'usually 1–4 min';

/** Which entries this view tracks the build/deploy lifecycle for. */
function isApprovedVersion(e: ListingHistoryEntry): boolean {
  return e.source === 'version' && e.status === 'approved';
}

function asLifecycleRow(e: ListingHistoryEntry) {
  return {
    status: e.status,
    deployState: e.deployState as DeployLifecycleState,
    deployUpdatedAt: e.deployUpdatedAt ?? null,
    reviewedAt: e.reviewedAt,
    deployDetail: e.deployDetail ?? null,
    buildSignals: e.buildSignals ?? null,
  };
}

/** Is any approved version still building or deploying, and not yet stalled? */
function hasFreshInFlightBuild(entries: ListingHistoryEntry[], now: number): boolean {
  return entries.some((e) => {
    if (!isApprovedVersion(e)) return false;
    const row = asLifecycleRow(e);
    return isInFlightDeploy(row) && !isStaleDeploy(row, now);
  });
}

/** Wall clock that ticks once a second while `active`, so elapsed time moves on screen. */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The approved-version build block for the app's team: the chip (with elapsed time while
 * building), and below the row the failure detail or the stranded notice.
 */
function versionBuildStatus(e: ListingHistoryEntry, isCurrentlyPublished: boolean, now: number) {
  if (!isApprovedVersion(e)) return { chip: undefined, below: null };
  const row = asLifecycleRow(e);
  const badge = deployStatusBadge(row, { isCurrentlyPublished, now });
  const elapsed =
    isInFlightDeploy(row) && !isStaleDeploy(row, now) ? deployElapsedMs(row, now) : null;
  const chip = badge ? (
    <Group gap={6} wrap="nowrap" data-testid={`apps-history-deploy-${e.id}`}>
      {badge}
      {elapsed != null && (
        <Text size="xs" c="dimmed" data-testid={`apps-history-elapsed-${e.id}`}>
          {formatElapsed(elapsed)}
          {row.deployState === 'building' ? ` · ${TYPICAL_BUILD_HINT}` : null}
        </Text>
      )}
    </Group>
  ) : undefined;
  let below: ReactNode = null;
  if (row.deployState === 'failed') {
    below = (
      <DeployFailureDetail
        detail={row.deployDetail}
        signals={row.buildSignals}
        testId={`apps-history-failure-${e.id}`}
      />
    );
  } else if (isStrandedDeploy(row, now)) {
    below = (
      <Alert
        color="orange"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title="Approved, but the build never started"
        data-testid={`apps-history-stranded-${e.id}`}
      >
        <Text size="sm">{STRANDED_DEPLOY_MESSAGE}</Text>
      </Alert>
    );
  }
  return { chip, below };
}

/** The pure view — no queries, so every state is renderable from props alone. */
export function ListingHistoryPanelView({
  entries,
  loading = false,
  errorMessage = null,
  onWithdraw,
  withdrawing = false,
  withdrawEnabled = true,
  now: pinnedNow,
}: ListingHistoryPanelViewProps) {
  const tickingNow = useTickingNow(
    pinnedNow === undefined && hasFreshInFlightBuild(entries, Date.now())
  );
  const now = pinnedNow ?? tickingNow;
  if (errorMessage) {
    return (
      <Alert color="red" variant="light" data-testid="apps-history-error">
        {errorMessage}
      </Alert>
    );
  }
  if (loading) {
    return (
      <Group gap="xs" data-testid="apps-history-loading">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading history…
        </Text>
      </Group>
    );
  }
  if (entries.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="apps-history-empty">
        No submissions yet for this app.
      </Text>
    );
  }
  // The live chip belongs to the newest approved VERSION only (listing edits are not
  // builds). Entries arrive newest-first.
  const publishedId = currentlyPublishedVersionId(entries.filter((e) => e.source === 'version'));
  return (
    <Stack gap={8} data-testid="apps-history-list">
      {entries.map((e) => {
        const { chip, below } = versionBuildStatus(e, e.id === publishedId, now);
        return (
          <Stack key={e.id} gap={6}>
            <ListingHistoryEntryRow
              entry={e}
              onWithdraw={onWithdraw}
              withdrawing={withdrawing}
              withdrawEnabled={withdrawEnabled}
              deployStatus={chip}
            />
            {below}
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * ONE publish-request entry, as a row.
 *
 * 🔴 EXPORTED SO THE MODERATOR'S PRIOR-VERSIONS MODAL RENDERS THE SAME RECORD. Two homes
 * for one record is how the two come to disagree about what a status means — the same rule
 * this file's own docblock states about the panel's move off `/apps/mine`. The mod surface
 * adds the submitter/reviewer chips and the "current" marker through `children` rather than
 * forking the row.
 */
export function ListingHistoryEntryRow({
  entry: e,
  onWithdraw,
  withdrawing = false,
  withdrawEnabled = true,
  deployStatus,
  children,
}: {
  entry: ListingHistoryEntry;
  onWithdraw?: (entry: ListingHistoryEntry) => void;
  withdrawing?: boolean;
  withdrawEnabled?: boolean;
  /**
   * Replaces the plain `· <deployState>` text when given — the author view's chip and
   * elapsed time. The moderator modal passes nothing and keeps the plain text.
   */
  deployStatus?: ReactNode;
  /** Rendered at the end of the row — the moderator surface's extra chips. */
  children?: ReactNode;
}) {
  return (
    <Group
      gap="xs"
      wrap="wrap"
      data-testid={`apps-history-entry-${e.id}`}
      data-history-source={e.source}
    >
      <Badge size="sm" variant="light" color={e.source === 'version' ? 'blue' : 'grape'}>
        {e.source === 'version' ? `v${e.version ?? '?'}` : 'Listing edit'}
      </Badge>
      <Badge
        size="sm"
        variant="outline"
        color={historyStatusColor(e.status)}
        data-testid={`apps-history-status-${e.id}`}
      >
        {e.status}
      </Badge>
      <Text size="xs" c="dimmed">
        {formatWhen(e.submittedAt)}
      </Text>
      {deployStatus !== undefined ? (
        deployStatus
      ) : e.deployState ? (
        <Text size="xs" c="dimmed">
          · {e.deployState}
        </Text>
      ) : null}
      {e.rejectionReason ? (
        <Text size="xs" c="red" data-testid={`apps-history-notes-${e.id}`}>
          {e.rejectionReason}
        </Text>
      ) : e.approvalNotes ? (
        <Text size="xs" c="dimmed" data-testid={`apps-history-notes-${e.id}`}>
          {e.approvalNotes}
        </Text>
      ) : null}
      {/*
        🔴 THREE CONDITIONS, and each one removes a button that could only fail.
        `canWithdraw` is the server restating its own submitter-scoped refusal;
        `withdrawEnabled` covers the FLAG mismatch (the version-withdraw mutation
        carries `enforceAppBlocksFlag` while this page and its reads gate on
        `appBlocksAuthor` only, so with the store flag off that half 403s).
      */}
      {e.canWithdraw && onWithdraw && (e.source === 'listing' || withdrawEnabled) ? (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          disabled={withdrawing}
          onClick={() => onWithdraw(e)}
          /*
            🔴 THE ONE-WAY WARNING IS ON THE CONTROL, not only in the toast that
            follows it. Withdrawing the review of a listing that was previously LIVE
            does not return it to how it was: the server closes it to `removed` behind
            a `delist` event, which the owner-republish guard reads as a moderator
            takedown, so only a moderator can put it back. That is deliberate (it
            closes a self-restore exploit — see `closeTerminalListing`), which is
            exactly why it has to be disclosed BEFORE the click rather than defended
            afterwards. Worded for the case it warns about without asserting the
            listing IS in it — this component cannot tell, and a warning that
            over-claims gets ignored.

            🔴 THE VERSION ENTRIES (`source === 'version'`) ARE NOW CONDITIONAL, which
            is why the hedged wording has to stay rather than be sharpened. Withdrawing
            a VERSION reaches `closeOnsiteResetListingOnWithdraw`, which since the
            asset-review route REFUSES to close a `pending` listing whose review
            belongs to the LISTING queue. So a version withdraw delists in the
            mod-reset case and does not in the republish-review case — and which case
            you are in depends on a row this component does not read. Warning in both
            is the safe direction for a one-way action; claiming either outcome
            per-entry would be an assertion this surface cannot support.
          */
          title="Withdraws this submission. If the listing was previously live, withdrawing takes it off the store and a moderator has to restore it."
          data-testid={`apps-history-withdraw-${e.id}`}
        >
          Withdraw
        </Button>
      ) : null}
      {children}
    </Group>
  );
}

/** The approved-version lifecycle rows a history payload carries, for the poll cadence. */
export function historyLifecycleRows(entries: ListingHistoryEntry[] | undefined) {
  return (entries ?? []).filter(isApprovedVersion).map(asLifecycleRow);
}

/** The container: the listing's own history read plus the two source-keyed withdraw procs. */
export function ListingHistoryPanel({ appListingId }: { appListingId: string }) {
  const features = useFeatureFlags();
  const query = trpc.appListings.listingHistory.useQuery(
    { appListingId },
    {
      retry: false,
      // Poll while any approved version is in flight (`deployRefetchInterval`) so its
      // chip and failure detail arrive without a reload.
      refetchInterval: (q) => deployRefetchInterval(historyLifecycleRows(q.state.data)),
    }
  );
  const utils = trpc.useUtils();

  /**
   * 🔴 FOUR READS, AND THE TWO ADDED AFTER REVIEW ARE THE ONES A WITHDRAW ACTUALLY MOVES.
   *
   * A withdraw is not only a status flip on a request row. `withdrawRequest` calls
   * `deleteOnsiteDraftListingForSlug`, which HARD-DELETES the pre-approval `draft` listing
   * to release the slug — and `draft` is authorable, so this panel is reachable on exactly
   * the listing that is about to stop existing. Withdrawing a first version therefore
   * deletes the row out from under the page it was clicked on.
   *
   * 🔴 THIS PATH DID NOT EXIST BEFORE THIS PR. On `/apps/mine` the history panel was a row
   * disclosure, and its container invalidated THREE reads including
   * `listMyOrphanedSubmissions` — which is precisely where a withdrawn first version goes
   * once its listing is gone. Moving the panel here created a surface where the same click
   * can invalidate the page's own identity, and the first version of this callback dropped
   * both of the reads that notice:
   *
   *   - `getAuthoringContext` — the read the WHOLE TAB SET derives from. Without it the
   *     page keeps rendering Details/Collaborators/Publishing for a listing that no longer
   *     exists, and every one of those tabs is a query that will now NOT_FOUND.
   *   - `listMyOrphanedSubmissions` — the only surface the withdrawn submission still has.
   *     Stale until a full reload, which is the same "it looks like it vanished" impression
   *     the orphan group exists to stop giving.
   *
   * Invalidating a read that did not change is free; failing to invalidate one that did is
   * a page rendering a listing that is gone.
   */
  const refetchHistory = useCallback(() => {
    void utils.appListings.listingHistory.invalidate();
    void utils.appListings.listMine.invalidate();
    void utils.appListings.getAuthoringContext.invalidate();
    void utils.appListings.listMyOrphanedSubmissions.invalidate();
  }, [utils]);

  const onWithdrawError = useCallback((message: string) => {
    showErrorNotification({ title: 'Withdraw failed', error: new Error(message) });
  }, []);

  const withdrawVersion = trpc.blocks.withdrawPublishRequest.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
      refetchHistory();
    },
    onError: (e) => onWithdrawError(e.message),
  });
  const withdrawListing = trpc.appListings.withdrawExternalRequest.useMutation({
    /**
     * 🔴 THE SERVER SAYS WHAT IT DID; DO NOT ASSUME. `outcome: 'removed'` means this
     * withdraw closed the review of a formerly-LIVE listing, so the listing is now OFF the
     * store behind a `delist` and the owner cannot republish it — a moderator must relist.
     * `'deleted'` merely discarded a draft. Announcing both as "Submission withdrawn."
     * left an owner looking at a "removed by a moderator" state they had caused
     * themselves, with nothing having told them it would happen.
     */
    onSuccess: (data) => {
      showSuccessNotification({ message: withdrawSuccessMessage(data?.outcome) });
      refetchHistory();
    },
    onError: (e) => onWithdrawError(e.message),
  });

  /**
   * 🔴 THE WITHDRAW MUTATION IS CHOSEN BY THE ENTRY'S OWN `source`, because the two
   * streams live in different tables with different procs — see
   * `app-listing-history.service`. Sending a listing-revision id to the block proc (or the
   * reverse) is a guaranteed NOT_FOUND.
   */
  const onWithdraw = useCallback(
    (entry: ListingHistoryEntry) => {
      if (entry.source === 'version') withdrawVersion.mutate({ publishRequestId: entry.id });
      else withdrawListing.mutate({ publishRequestId: entry.id });
    },
    [withdrawVersion, withdrawListing]
  );

  return (
    <ListingHistoryPanelView
      entries={(query.data ?? []) as ListingHistoryEntry[]}
      loading={query.isLoading}
      errorMessage={query.error?.message ?? null}
      onWithdraw={onWithdraw}
      withdrawing={withdrawVersion.isPending || withdrawListing.isPending}
      withdrawEnabled={!!features?.appBlocks}
    />
  );
}
