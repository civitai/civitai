import { Alert, Badge, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { useCallback } from 'react';

import { historyStatusColor } from '~/components/Apps/myAppsView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
 *     narrowed mode whose tab set is at most Publishing + History, and the row links to it.
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
};

/** The pure view — no queries, so every state is renderable from props alone. */
export function ListingHistoryPanelView({
  entries,
  loading = false,
  errorMessage = null,
  onWithdraw,
  withdrawing = false,
  withdrawEnabled = true,
}: ListingHistoryPanelViewProps) {
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
  return (
    <Stack gap={8} data-testid="apps-history-list">
      {entries.map((e) => (
        <Group
          key={e.id}
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
          {e.deployState ? (
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
              data-testid={`apps-history-withdraw-${e.id}`}
            >
              Withdraw
            </Button>
          ) : null}
        </Group>
      ))}
    </Stack>
  );
}

/** The container: the listing's own history read plus the two source-keyed withdraw procs. */
export function ListingHistoryPanel({ appListingId }: { appListingId: string }) {
  const features = useFeatureFlags();
  const query = trpc.appListings.listingHistory.useQuery({ appListingId }, { retry: false });
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
    onSuccess: () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
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
