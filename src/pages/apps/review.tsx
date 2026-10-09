import { Badge, Tabs } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import {
  IconCheck,
  IconClipboardList,
  IconClock,
  IconFlag,
  IconLayoutGrid,
  IconMessage2,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ActivePreviewsPanel } from '~/components/Apps/ActivePreviewsPanel';
import { AppFeedbackModQueue } from '~/components/Apps/AppFeedbackModQueue';
import { canMonitorAppFeedback } from '~/components/Apps/appFeedbackModView';
import { AppListingsModerationTable } from '~/components/Apps/AppListingsModerationTable';
import { SubListingReviewQueue } from '~/components/Apps/SubListingReviewQueue';
// The off-site review MODAL is now PAGE-OWNED (lifted here) so a single instance is
// shared by the unified Pending list AND the `AppListingsModerationTable` — no
// divergence. `OffsiteReportsQueue` still powers the Reports tab.
import {
  OffsiteReportsQueue,
  OffsiteReviewModal,
  type OffsitePendingRow,
} from '~/components/Apps/OffsiteReviewQueue';
// The on-site (App Block) review modal + its request types were EXTRACTED to
// `OnsiteReviewModal.tsx` so the modal is importable into a browser test WITHOUT
// this page's `getServerSideProps` tRPC-server graph.
import {
  OnsiteReviewModal,
  type AnyRequest,
  type OnsiteReviewMode,
} from '~/components/Apps/OnsiteReviewModal';
import {
  CombinedReviewModal,
  type CombinedReviewSelection,
} from '~/components/Apps/CombinedReviewModal';
import {
  PriorVersionsModal,
  type PriorVersionsSelection,
} from '~/components/Apps/PriorVersionsModal';
import { UnifiedReviewList, type VersionHistoryTarget } from '~/components/Apps/UnifiedReviewList';
import type {
  CombinedReviewPayload,
  OffsiteReviewRequest,
  OnsiteReviewRequest,
} from '~/components/Apps/unifiedReviewRow';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { EMBEDDED_KIND_LABEL, STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/review — Moderator review queue + history for Apps (on-site App Blocks AND
 * off-site external listings), UNIFIED into one list per tab.
 *
 * Seven tabs:
 *  - Pending  — ONE oldest-first FIFO list interleaving on-site publish requests
 *               (`blocks.listPendingRequests`) + off-site requests
 *               (`appListings.listPendingRequests`). Each row carries a kind badge
 *               (App / External) and a Review action that opens the CORRECT modal.
 *  - Approved — unified newest-first history (on-site + off-site approved requests).
 *  - Rejected — unified newest-first history (on-site + off-site rejected requests).
 *  - Reports  — off-site listing report queue + mod takedown actions (unchanged).
 *  - Manage listings — the full all-status lifecycle table (reset/relist/claim/purge).
 *  - Sub-listings — store items inside apps, and staged edits to them.
 *  - App feedback — users' private feedback to app developers, with hide/unhide (gated on
 *               `isModerator`, not the page gate).
 *
 * Both review modals are PAGE-OWNED (lifted here): the on-site `OnsiteReviewModal`
 * and the off-site `OffsiteReviewModal`. The unified list + the management table
 * both call the page's `openOnsiteReview` / `openOffsiteReview` — so there is exactly
 * ONE instance of each modal and the kinds never cross. This is presentation +
 * modal-state lifting only: no server proc, modal internal, or approve/reject/
 * lifecycle logic changes.
 *
 * Active tab is mirrored to `?tab=` so a mod can deep-link a specific view.
 *
 * v0 gate: requires `isAppReviewer`. Dark + mod-only.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppReviewer(session.user)) {
      return { notFound: true };
    }
    return { props: { canMonitorAppFeedback: canMonitorAppFeedback(session.user) } };
  },
});

const TAB_VALUES = [
  'pending',
  'approved',
  'rejected',
  'reports',
  'manage',
  'sub-listings',
  'app-feedback',
] as const;
type TabValue = (typeof TAB_VALUES)[number];

export function isTabValue(v: unknown): v is TabValue {
  return (TAB_VALUES as readonly unknown[]).includes(v);
}

/** A tab the viewer cannot see falls back to `pending` rather than mounting a refused panel. */
export function resolveReviewTab(
  value: unknown,
  { appFeedback }: { appFeedback: boolean }
): TabValue {
  if (!isTabValue(value)) return 'pending';
  if (value === 'app-feedback' && !appFeedback) return 'pending';
  return value;
}

/** Rows fetched per source per page (bounded by each proc's schema at ≤100). Mod
 *  queues are low/moderate volume, so one bounded page per source + Load-more is
 *  simple and correct. */
const PAGE_LIMIT = 50;

/**
 * How often the PENDING queue re-fetches itself, in ms.
 *
 * 15s was taken from `QUEUE_POLL_MS` in `src/pages/moderator/resource-load.tsx`, the
 * other moderator queue that polls — as a starting value, NOT as a coupling. That
 * constant is module-local and unexported, so nothing could enforce the two staying
 * equal; a docstring claiming they move together would read as coverage and provide
 * none. They are unrelated queues and either is free to be retuned alone.
 *
 * The history tabs (Approved / Rejected) deliberately do NOT poll: they are an audit
 * record, nothing arrives in them unprompted, and a poll there would re-fetch two queries
 * forever for a view nobody is waiting on.
 */
export const APPS_REVIEW_POLL_MS = 15_000;

/*
 * 🔴 THE POLL HAS NO REFUSALS — IT IS THE CONSTANT ABOVE, UNCONDITIONALLY, ON BOTH
 * PENDING QUERIES. Two gates were shipped and both have since been deleted. Each argument
 * is recorded here rather than dropped, because they are the arguments a future reader
 * will re-derive and re-add.
 *
 * 🔴 NO CURSOR GATE — THE ARGUMENT FOR ONE WAS BACKWARDS FOR THIS QUEUE. An earlier
 * revision parked the poll whenever either source held a cursor, reasoning that a poll
 * would then refresh only the LAST-loaded page while every earlier page silently went
 * stale. But Pending is OLDEST-FIRST (`orderBy: { submittedAt: 'asc' }` in
 * `~/server/services/blocks/publish-request.service`, rendered `direction="asc"` below)
 * and both sources are keyset-paginated on that order — so a NEW submission sorts LAST.
 *
 * ⚠️ THAT LAST STEP DOES NOT REACH AS FAR AS AN EARLIER DRAFT OF THIS PARAGRAPH CLAIMED,
 * and the overreach is recorded rather than quietly fixed. It said a new submission
 * "lands in exactly the window the last-loaded page's cursor covers". That holds only
 * when the last-loaded page is also the FINAL page: both procs take `limit + 1` from the
 * cursor, so a mod sitting on page 2 of a longer backlog gets a new submission sorted
 * onto a LATER page, and the refreshed page-2 window never contains it. Polling while
 * paged is therefore NOT a strict information gain in general.
 *
 * What survives, and what actually retires the gate: the earlier pages go stale on
 * REMOVALS, and they go stale on those identically when nothing polls at all — so
 * parking bought nothing on the axis it was defended on. And the gate had no exit: a mod
 * who clicked Load more saw no new submission again until they actioned a review,
 * switched tabs or reloaded, with nothing on screen to say so.
 *
 * MEASURED against production 2026-09-28, because the paged branch is the one every
 * argument here is about: a cursor exists only past PAGE_LIMIT (50) pending rows in ONE
 * source, and the peak CONCURRENTLY pending was 9 on each — on-site is additionally
 * capped at one pending row per slug by the `…_one_pending_per_slug` partial unique
 * index. So no mod has ever reached this branch.
 *
 * The figures are a snapshot and nothing asserts on them, so re-derive rather than trust.
 * The method, since a figure without one cannot be checked: sweep `submitted_at` as +1
 * against `reviewed_at` (falling back to `updated_at`, and to `now()` only for rows still
 * `pending`) as −1, and take the running maximum, over `app_block_publish_requests` and
 * `app_listing_publish_requests`. 🔴 `COALESCE(reviewed_at, now())` is the trap: every
 * `withdrawn` row has a NULL `reviewed_at`, so that form counts all of them as still
 * pending forever and returned 64 — which is just (pending + withdrawn), not a peak.
 * Two conservative notes: the off-site proc additionally filters `kind` to the reviewable
 * set, so the figure above is an upper bound on what that queue can page through; and a
 * peak is not a ceiling — the ceiling is how many apps can hold a pending row at once.
 *
 * 🔴 NO ERROR GATE — BECAUSE THIS TAB CARRIES ZERO EXTRA UI, NOT BECAUSE SUCH A PARK
 * WOULD BE UNRECOVERABLE. ⚠️ An earlier revision of this paragraph claimed the latter and
 * it was FALSE, in both mechanisms it named. `refetchOnReconnect` defaults to `true`
 * (`queryClient.js:271-272` — `networkMode !== 'always'`), and it does NOT resolve
 * through a staleness check that a query holding data can never pass: a background error
 * sets `isInvalidated: true` on the existing data (query-core 5.101.0 `query.js:386-388`,
 * in-source comment "flag existing data as invalidated if we get a background error"),
 * and `isStaleByTime` returns `true` for an invalidated query whatever the `staleTime`
 * (`query.js:134`). Remounting recovers it too — and with `Tabs keepMounted={false}` on
 * this page a remount is one click, to Approved and back.
 *
 * ⚠️ TWO EARLIER DRAFTS REACHED FOR A REASON AND BOTH WERE WRONG; THE THIRD IS BELOW AND
 * IS A PROPERTY OF THE QUERIES, NOT A PREFERENCE. Draft two said the gate is absent
 * because "the chosen design for this tab is zero extra chrome". Draft three said
 * `~/components/Apps/ActivePreviewsPanel` runs that gate "with no status row and no
 * Refresh control", and concluded that nothing requires the gate's absence. THAT IS
 * FALSE: on a non-authz error that panel renders `ModQueryError` with an `onRetry` that
 * refetches — an alert AND a retry control — in exactly the state its gate creates.
 *
 * The real distinction is the one that panel states in its own comment: its query has a
 * PERMANENTLY-DEAD state. With `appBlocks` on but the review-sandbox flag off the server
 * throws UNAUTHORIZED for good, so a fixed interval would re-fire a guaranteed-dead
 * request forever — that is what its gate exists to stop, and why it also needs a manual
 * retry to escape.
 *
 * These two queries have no such state. The page's own gate is `isAppReviewer` (=
 * `!!user.isModerator`, `~/shared/utils/app-blocks-access`) plus `features.appBlocks`,
 * and the procs require exactly the same pair (`moderatorProcedure` + the app-blocks flag
 * middleware). A viewer who got this page rendered therefore cannot hold a standing
 * authorization failure on them: an error here is TRANSIENT by construction, and a
 * transient error is cleared by the very next tick. The gate would have nothing to stop.
 *
 * So: a reader who wants the gate back has to show a durable error state these queries
 * can actually reach — not defeat a design preference. Do not restate the recoverability
 * claim, and do not restate the no-chrome claim.
 * (The contradiction surfaced because the `refetchOnWindowFocus` note below already
 * stated the `isInvalidated` carve-out correctly while this paragraph denied it.)
 */

/** Append `page` onto `accumulated`, dropping ids already present (defensive dedup
 *  in case Load-more double-fires before a fetch settles). */
function mergeById<T extends { id: string }>(accumulated: T[], page: T[]): T[] {
  const seen = new Set(accumulated.map((r) => r.id));
  return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
}

/** Pending store items — new ones plus edits to approved ones — shown on the tab label. */
export function SubListingPendingBadge() {
  const { data } = trpc.appListings.countSubListingQueue.useQuery(undefined, {
    refetchInterval: APPS_REVIEW_POLL_MS,
    retry: false,
  });
  if (!data?.count) return null;
  return (
    <Badge size="xs" color="yellow" variant="filled" data-testid="sub-listing-pending-count">
      {data.count}
    </Badge>
  );
}

/** Reports a developer flagged that no moderator has hidden yet, shown on the tab label. */
export function AppFeedbackFlaggedBadge() {
  const { data } = trpc.appFeedback.modCountFlagged.useQuery(undefined, {
    refetchInterval: APPS_REVIEW_POLL_MS,
    retry: false,
  });
  if (!data) return null;
  return (
    <Badge size="xs" color="red" variant="filled" data-testid="app-feedback-flagged-count">
      {data}
    </Badge>
  );
}

export default function ReviewQueuePage({
  canMonitorAppFeedback: showAppFeedback = false,
}: {
  canMonitorAppFeedback?: boolean;
}) {
  const features = useFeatureFlags();
  const router = useRouter();

  // Sync active tab with `?tab=` so deep-links land on the right view. Shallow
  // routing so the page query doesn't re-trigger getServerSideProps.
  const tab: TabValue = useMemo(
    () => resolveReviewTab(router.query.tab, { appFeedback: showAppFeedback }),
    [router.query.tab, showAppFeedback]
  );

  const setTab = (next: TabValue) => {
    void router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: next } },
      undefined,
      { shallow: true }
    );
  };

  // On-site review modal selection (page-owned). `onActioned` lets the opening tab
  // refresh its own paginated query after an approve/reject (symmetric with off-site).
  const [selected, setSelected] = useState<{
    request: AnyRequest;
    mode: OnsiteReviewMode;
    onActioned?: () => void | Promise<void>;
  } | null>(null);
  // Off-site review modal — LIFTED to the page so one instance is shared by the
  // unified Pending list and the management table. `onActioned` lets whichever
  // surface opened it refresh its own paginated query after an approve/reject;
  // `readOnly` makes a history-tab (Approved/Rejected) open a read-only detail view
  // (no Approve/Reject buttons) — matching the on-site history posture.
  const [offsiteReview, setOffsiteReview] = useState<{
    row: OffsitePendingRow;
    onActioned?: () => void | Promise<void>;
    readOnly?: boolean;
  } | null>(null);
  // Combined code+media review surface — opened when a PENDING row is an app that has
  // BOTH a pending code request AND a pending listing-media revision (page-owned, one
  // instance). Each stacked section keeps its own independent approve/reject.
  const [combinedReview, setCombinedReview] = useState<CombinedReviewSelection>(null);
  /**
   * PRIOR-VERSIONS modal — page-owned for the same reason as the three above, and here the
   * reason is sharper: the Pending queue refetches every 15s and its rows are
   * whole-row-clickable, so row-local state would be torn down under a moderator mid-read.
   */
  const [priorVersions, setPriorVersions] = useState<PriorVersionsSelection>(null);

  // DUAL-PATH on-site row selection: under the `appReviewPage` flag a row NAVIGATES
  // to the deep-linkable detail page `/apps/review/<id>`; with the flag off it opens
  // the modal exactly as before. Off-site has no detail page → always the modal.
  const linkToPage = !!features?.appReviewPage;

  const openOnsiteReview = useCallback(
    (request: AnyRequest, mode: OnsiteReviewMode, onActioned?: () => void | Promise<void>) => {
      if (linkToPage) {
        void router.push(`/apps/review/${request.id}`);
        return;
      }
      setSelected({ request, mode, onActioned });
    },
    [linkToPage, router]
  );

  const openOffsiteReview = useCallback(
    (row: OffsitePendingRow, onActioned?: () => void | Promise<void>, readOnly = false) => {
      setOffsiteReview({ row, onActioned, readOnly });
    },
    []
  );

  const openCombinedReview = useCallback(
    (payload: CombinedReviewPayload, onActioned?: () => void | Promise<void>) => {
      setCombinedReview({ ...payload, onActioned });
    },
    []
  );

  const openVersionHistory = useCallback((target: VersionHistoryTarget) => {
    setPriorVersions(target);
  }, []);

  if (!features?.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="App publish-request queue — Civitai" deIndex />
      {/*
        🔴 NO `measure` — this page took a 1368 cap until the wide-tables pass, and
        removing it is the point rather than a side effect. The cap existed because four
        short columns could not spend the container, so the surplus landed as padding
        between the last column and the Review button. `UnifiedReviewList` now carries a
        proportional `<colgroup>` (`APPS_REVIEW_QUEUE_COLUMNS`), so the width goes into
        the App column instead. Re-adding a cap here would hide that rather than help it.
      */}
      <AppsPageLayout
        title="App publish-request queue"
        subtitle={`Moderator review for Apps. ${EMBEDDED_KIND_LABEL} + ${STANDALONE_KIND_LABEL} submissions share one queue per tab; Pending is oldest-first, history is newest-first.`}
      >
        <ActivePreviewsPanel />

        <Tabs
          value={tab}
          onChange={(v) => {
            if (isTabValue(v)) setTab(v);
          }}
          keepMounted={false}
        >
          <Tabs.List>
            <Tabs.Tab value="pending" leftSection={<IconClock size={14} />}>
              Pending
            </Tabs.Tab>
            <Tabs.Tab value="approved" leftSection={<IconCheck size={14} />}>
              Approved
            </Tabs.Tab>
            <Tabs.Tab value="rejected" leftSection={<IconX size={14} />}>
              Rejected
            </Tabs.Tab>
            <Tabs.Tab value="reports" leftSection={<IconFlag size={14} />}>
              Reports
            </Tabs.Tab>
            <Tabs.Tab value="manage" leftSection={<IconClipboardList size={14} />}>
              Manage listings
            </Tabs.Tab>
            <Tabs.Tab
              value="sub-listings"
              leftSection={<IconLayoutGrid size={14} />}
              rightSection={<SubListingPendingBadge />}
            >
              Sub-listings
            </Tabs.Tab>
            {showAppFeedback && (
              <Tabs.Tab
                value="app-feedback"
                leftSection={<IconMessage2 size={14} />}
                rightSection={<AppFeedbackFlaggedBadge />}
              >
                App feedback
              </Tabs.Tab>
            )}
          </Tabs.List>

          <Tabs.Panel value="pending" pt="md">
            {/* ONE unified oldest-first queue: on-site + off-site pending requests. */}
            <UnifiedPendingTab
              openOnsiteReview={openOnsiteReview}
              openOffsiteReview={openOffsiteReview}
              openCombinedReview={openCombinedReview}
              openVersionHistory={openVersionHistory}
            />
          </Tabs.Panel>

          <Tabs.Panel value="approved" pt="md">
            <UnifiedHistoryTab
              kind="approved"
              openOnsiteReview={openOnsiteReview}
              openOffsiteReview={openOffsiteReview}
              openVersionHistory={openVersionHistory}
            />
          </Tabs.Panel>

          <Tabs.Panel value="rejected" pt="md">
            <UnifiedHistoryTab
              kind="rejected"
              openOnsiteReview={openOnsiteReview}
              openOffsiteReview={openOffsiteReview}
              openVersionHistory={openVersionHistory}
            />
          </Tabs.Panel>

          <Tabs.Panel value="reports" pt="md">
            {/* Off-site listing REPORT queue + mod takedown actions. Unchanged. */}
            <OffsiteReportsQueue />
          </Tabs.Panel>

          <Tabs.Panel value="sub-listings" pt="md">
            <SubListingReviewQueue />
          </Tabs.Panel>

          <Tabs.Panel value="manage" pt="md">
            {/* Full all-status listings MANAGEMENT table (reset/relist/claim/purge).
                Its pending rows' Review action opens the same page-owned off-site
                modal; its lifecycle-action modals stay local to it. */}
            <AppListingsModerationTable openOffsiteReview={openOffsiteReview} />
          </Tabs.Panel>

          {showAppFeedback && (
            <Tabs.Panel value="app-feedback" pt="md">
              <AppFeedbackModQueue />
            </Tabs.Panel>
          )}
        </Tabs>
      </AppsPageLayout>

      <OnsiteReviewModal
        selection={selected}
        onClose={() => setSelected(null)}
        onActioned={selected?.onActioned}
      />
      <OffsiteReviewModal
        request={offsiteReview?.row ?? null}
        onClose={() => setOffsiteReview(null)}
        onActioned={offsiteReview?.onActioned}
        readOnly={offsiteReview?.readOnly}
      />
      <CombinedReviewModal selection={combinedReview} onClose={() => setCombinedReview(null)} />
      <PriorVersionsModal selection={priorVersions} onClose={() => setPriorVersions(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Unified PENDING tab — one oldest-first list merging the on-site + off-site
// pending queues. Each source is independently keyset-paginated; Load-more
// advances whichever source(s) still have a next page, and the pure merge
// re-sorts the full accumulated set. (Global order across the two independently-
// paginated sources is exact once both first pages are loaded — fine at mod-queue
// volumes; we never build a server-side cross-table cursor.)
// ---------------------------------------------------------------------------

/**
 * 🔴 EXPORTED FOR ONE REASON: the Load-more / background-poll interaction is only
 * observable on a MOUNTED tab. The claim — "a background refetch must not put Load more
 * into its loading state" — is a statement about this component's own state machine
 * (`loadingMore` below), not about a pure function, so
 * `src/tests/pages/apps/review/review-queue-poll.browser.test.tsx` renders it directly. Nothing in the
 * app imports it; it stays page-local by convention. A named export alongside a page's
 * default is ordinary here (`src/pages/apps/activity.tsx`, `src/pages/home/index.tsx`).
 */
export function UnifiedPendingTab({
  openOnsiteReview,
  openOffsiteReview,
  openCombinedReview,
  openVersionHistory,
}: {
  openOnsiteReview: (
    req: AnyRequest,
    mode: OnsiteReviewMode,
    onActioned?: () => void | Promise<void>
  ) => void;
  openOffsiteReview: (
    row: OffsitePendingRow,
    onActioned?: () => void | Promise<void>,
    readOnly?: boolean
  ) => void;
  openCombinedReview: (
    payload: CombinedReviewPayload,
    onActioned?: () => void | Promise<void>
  ) => void;
  /** Opens the page-owned prior-versions modal. Optional so the poll harness can mount
   *  this tab without it. */
  openVersionHistory?: (target: VersionHistoryTarget) => void;
}) {
  const features = useFeatureFlags();
  const enabled = !!features?.appBlocks;

  const [onsiteCursor, setOnsiteCursor] = useState<string | undefined>(undefined);
  const [offsiteCursor, setOffsiteCursor] = useState<string | undefined>(undefined);
  const [onsiteAcc, setOnsiteAcc] = useState<OnsiteReviewRequest[]>([]);
  const [offsiteAcc, setOffsiteAcc] = useState<OffsiteReviewRequest[]>([]);

  /**
   * 🔴 IS AN EXPLICIT, USER-INITIATED "LOAD MORE" IN FLIGHT — `false` MEANS EVERY FETCH
   * HAPPENING RIGHT NOW IS A BACKGROUND ONE, AND NO CONTROL MAY SPIN FOR IT.
   *
   * This exists because of the poll, and it is the whole reason the naive one-line
   * `refetchInterval` is not enough. The Load-more button used to take
   * `isLoadingMore={onsiteQuery.isFetching || offsiteQuery.isFetching}`, and `isFetching`
   * is true for a BACKGROUND refetch exactly as it is for a foreground one — so with a
   * 15s poll running, that button would drop into its loading+disabled state for the
   * duration of every poll, forever, on a page nobody had touched. A moderator reaching
   * for Load more would find it dead about as often as not.
   *
   * It is a boolean rather than a `'loadMore' | 'refresh' | null` union because the
   * Refresh control this page briefly carried is gone (see `APPS_REVIEW_POLL_MS`) and its
   * arm was the only other member. Clearing is one-directional: nothing here ever SETS the
   * flag from a background signal, and the effect below clears it as soon as the pair is
   * idle, so it cannot stick.
   *
   * ⚠️ IF THIS TAB IS EVER MOVED TO `useInfiniteQuery`, DELETE THIS RATHER THAN PORTING IT
   * — `isFetchingNextPage` IS THIS, FROM THE LIBRARY. `infiniteQueryObserver.js` derives it
   * as `isFetching && fetchDirection === 'forward'`, and `fetchDirection` is set only by a
   * `fetchNextPage()` call, so it is already false for a poll and a focus refetch — exactly
   * the discrimination the paragraph above hand-rolls. Both procs already satisfy the
   * contract with no server change (optional `cursor` in, `nextCursor` out), and the
   * moderator-queue idiom is `src/pages/moderator/challenges.tsx`. That switch would also
   * widen what a poll REFRESHES: `infiniteQueryBehavior.js` re-fetches every loaded page
   * from the first on an undirected refetch, where this hand-rolled accumulator refreshes
   * only the last-loaded page — strictly more data per tick, at N sequential requests per
   * source. Deliberately NOT done here: it is a rewrite of the tab's paging, and it would
   * leave Pending and History on two different paging mechanisms.
   */
  const [loadingMore, setLoadingMore] = useState(false);

  const onsiteQuery = trpc.blocks.listPendingRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: onsiteCursor },
    {
      enabled,
      retry: false,
      // 🔴 UNCONDITIONAL — gated on neither this query's error nor the paging cursor.
      // Both refusals were shipped and both were deleted; the arguments are on
      // `APPS_REVIEW_POLL_MS` above.
      refetchInterval: APPS_REVIEW_POLL_MS,
      /**
       * 🔴 `'always'`, NOT `true`, AND THE DIFFERENCE IS THE WHOLE OPTION. DO NOT "TIDY"
       * IT.
       *
       * A deliberate per-query override of the repo-wide `refetchOnWindowFocus: false` in
       * `src/utils/trpc.ts`: coming back to the tab is the strongest signal a mod is about
       * to act on this list, and a stale row is exactly what gets mis-clicked. But the
       * repo ALSO sets `staleTime: Infinity` there, and `true` is gated on staleness —
       * `shouldFetchOn` (query-core 5.101.0 `queryObserver.js:450-453`) returns
       * `value === 'always' || (value !== false && isStale(query, options))`, and `isStale`
       * is `query.isStaleByTime(Infinity)`, which is `false` whenever the query holds data
       * and is not invalidated. So a plain `true` is SILENTLY INERT in precisely the state
       * it was added for — it would fire only before the first successful load, and nothing
       * about the option's spelling would say so. `'always'` short-circuits ahead of that
       * staleness check.
       *
       * ⚠️ `src/hooks/useIsLive.ts` pairs the option with an explicit `staleTime` instead,
       * and that is NOT equivalent — it is the nearest precedent, not the same behaviour.
       * `true` + a finite `staleTime` DEDUPES rapid refocus; `'always'` refetches on every
       * hidden→visible transition. The difference is negligible for two low-volume queries
       * at human alt-tab speed, and it is stated rather than glossed because it is a real
       * behavioural divergence from the simpler form.
       *
       * It is a plain value rather than a callback because there is nothing per-query left
       * for a callback to read: the cursor gate that used to make this a decision is gone.
       *
       * `refetchIntervalInBackground` stays UNSET. ⚠️ Precisely: the TIMER is not paused —
       * `#updateRefetchInterval` (`queryObserver.js:208-219`) keeps a plain `setInterval`
       * and the CALLBACK skips the fetch while the document is hidden. Nothing here depends
       * on the difference, but do not reason from it that returning to a tab restarts the
       * cadence from zero; it does not.
       */
      refetchOnWindowFocus: 'always',
      /**
       * 🔴 WITHOUT THIS, THE LOAD-MORE SPINNER RENDERS IN NO REACHABLE STATE — the control
       * it belongs to is UNMOUNTED for the whole fetch it is meant to describe.
       *
       * `cursor` is part of the query key, so "Load more" makes a key that has never been
       * fetched and `data` goes `undefined` until the new page lands. `hasMore` is
       * `onsiteNext != null || offsiteNext != null`, both read off `data?.nextCursor`, so
       * it flips to FALSE for the duration — and `UnifiedReviewList` renders the button
       * under `{hasMore && …}`. A moderator on a slow page therefore watched the button
       * VANISH, with the count line dropping its `+` at the same moment, which reads as
       * "there is nothing more". The rows themselves stayed put (the accumulators hold
       * them), so only the affordance disappeared.
       *
       * That is a pre-existing defect, but the `loadingMore` work above would have
       * shipped a docblock and a "positive control" test asserting the opposite. With the
       * previous page kept, `hasMore` and `isLoading` stop flickering across a page turn,
       * the button stays mounted, and its loading state becomes a state that exists.
       *
       * Safe against duplication by construction: while this serves page N, `onLoadMore`
       * has already written page N into the accumulator, and `mergeById` drops ids it
       * already holds. The repo idiom — `AppCollaboratorsPanel.tsx`, and the guard class in
       * `AppListingsMarketplaceBody.keepPreviousData.browser.test.tsx`.
       */
      placeholderData: keepPreviousData,
    }
  );
  const offsiteQuery = trpc.appListings.listPendingRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: offsiteCursor },
    {
      enabled,
      retry: false,
      // Identical wiring to the on-site query above; the reasoning lives on
      // `APPS_REVIEW_POLL_MS` and in that query's `refetchOnWindowFocus` /
      // `placeholderData` docblocks rather than being restated here.
      refetchInterval: APPS_REVIEW_POLL_MS,
      refetchOnWindowFocus: 'always',
      placeholderData: keepPreviousData,
    }
  );

  const anyFetching = onsiteQuery.isFetching || offsiteQuery.isFetching;
  useEffect(() => {
    // Clear as soon as the pair is idle again. Deliberately one-directional — nothing here
    // ever SETS the flag, so a background fetch can never turn a control into a spinner.
    if (loadingMore && !anyFetching) setLoadingMore(false);
  }, [loadingMore, anyFetching]);

  const onsitePage = (onsiteQuery.data?.items ?? []) as OnsiteReviewRequest[];
  const offsitePage = (offsiteQuery.data?.items ?? []) as OffsiteReviewRequest[];

  const onsiteItems = useMemo(
    () => (onsiteCursor ? mergeById(onsiteAcc, onsitePage) : onsitePage),
    [onsiteAcc, onsitePage, onsiteCursor]
  );
  const offsiteItems = useMemo(
    () => (offsiteCursor ? mergeById(offsiteAcc, offsitePage) : offsitePage),
    [offsiteAcc, offsitePage, offsiteCursor]
  );

  const onsiteNext = onsiteQuery.data?.nextCursor ?? null;
  const offsiteNext = offsiteQuery.data?.nextCursor ?? null;

  const resetPaging = useCallback(() => {
    setOnsiteAcc([]);
    setOffsiteAcc([]);
    setOnsiteCursor(undefined);
    setOffsiteCursor(undefined);
  }, []);

  const boundOnsite = useCallback(
    // Register the tab's paging reset as the onsite modal's post-success callback so
    // approving/rejecting an onsite item clears the accumulators + refetches page 1
    // (mirrors the offsite path — kills the stale ghost-row after a decision).
    (req: OnsiteReviewRequest) => openOnsiteReview(req, 'pending', resetPaging),
    [openOnsiteReview, resetPaging]
  );
  const boundOffsite = useCallback(
    (row: OffsitePendingRow) => openOffsiteReview(row, resetPaging),
    [openOffsiteReview, resetPaging]
  );
  const boundCombined = useCallback(
    (payload: CombinedReviewPayload) => openCombinedReview(payload, resetPaging),
    [openCombinedReview, resetPaging]
  );

  const onLoadMore = () => {
    if (onsiteNext != null) {
      setOnsiteAcc(onsiteItems);
      setOnsiteCursor(onsiteNext);
    }
    if (offsiteNext != null) {
      setOffsiteAcc(offsiteItems);
      setOffsiteCursor(offsiteNext);
    }
    // Unconditional, and it needs no `advanced` guard: `UnifiedReviewList` only renders the
    // control this is bound to under `hasMore`, which is exactly
    // `onsiteNext != null || offsiteNext != null` — so at least one branch above always
    // ran. A guard here would be a branch no test could ever reach, which reads as care
    // and provides none. And even a hypothetical no-op call is harmless: the effect above
    // clears the flag on the next render when nothing is fetching.
    setLoadingMore(true);
  };

  /*
   * 🔴 ZERO EXTRA CHROME, AND THAT IS THE CHOSEN DESIGN RATHER THAN AN OMISSION. The tab
   * renders the list and nothing else: the queue simply repaints itself every 15s, and on
   * a tab reveal — in every state, paged or not, since the cursor gate was deleted.
   * Rows here are whole-row-clickable (`~/components/Apps/UnifiedReviewList`),
   * so a silent repaint can move a row under the cursor mid-click — that hazard was weighed
   * against a status line and a Refresh button and knowingly accepted, because the poll is
   * self-healing and a mod therefore never needs a manual resume path. An earlier revision
   * shipped both controls; they existed only to explain and undo an error gate that has
   * since been deleted. `review-queue-poll.browser.test.tsx` asserts that this tab
   * contributes no controls of its own, so the chrome cannot creep back unnoticed.
   */
  return (
    <UnifiedReviewList
      onsiteItems={onsiteItems}
      offsiteItems={offsiteItems}
      direction="asc"
      openOnsiteReview={boundOnsite}
      openOffsiteReview={boundOffsite}
      openCombinedReview={boundCombined}
      openVersionHistory={openVersionHistory}
      isLoading={onsiteQuery.isLoading || offsiteQuery.isLoading}
      errorMessage={onsiteQuery.error?.message ?? offsiteQuery.error?.message}
      emptyLabel="Queue is empty. Nothing waiting for review."
      dateLabel="Submitted"
      actionLabel="Review"
      hasMore={onsiteNext != null || offsiteNext != null}
      // 🔴 NOT `isFetching` — see `loadingMore`. A background poll must not disable this
      // button.
      isLoadingMore={loadingMore}
      onLoadMore={onLoadMore}
    />
  );
}

// ---------------------------------------------------------------------------
// Unified HISTORY tab (drives both Approved + Rejected) — newest-first, merging
// the on-site + off-site decided requests. Mirrors the pending tab's dual-source
// keyset pagination. All four history queries are declared (rules of hooks); only
// the active kind's pair is enabled.
// ---------------------------------------------------------------------------

function UnifiedHistoryTab({
  kind,
  openOnsiteReview,
  openOffsiteReview,
  openVersionHistory,
}: {
  kind: 'approved' | 'rejected';
  openVersionHistory?: (target: VersionHistoryTarget) => void;
  openOnsiteReview: (
    req: AnyRequest,
    mode: OnsiteReviewMode,
    onActioned?: () => void | Promise<void>
  ) => void;
  openOffsiteReview: (
    row: OffsitePendingRow,
    onActioned?: () => void | Promise<void>,
    readOnly?: boolean
  ) => void;
}) {
  const features = useFeatureFlags();
  const enabled = !!features?.appBlocks;
  const isApproved = kind === 'approved';

  const [onsiteCursor, setOnsiteCursor] = useState<string | undefined>(undefined);
  const [offsiteCursor, setOffsiteCursor] = useState<string | undefined>(undefined);
  const [onsiteAcc, setOnsiteAcc] = useState<OnsiteReviewRequest[]>([]);
  const [offsiteAcc, setOffsiteAcc] = useState<OffsiteReviewRequest[]>([]);

  const onsiteApprovedQ = trpc.blocks.listApprovedRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: onsiteCursor },
    { enabled: enabled && isApproved, retry: false }
  );
  const onsiteRejectedQ = trpc.blocks.listRejectedRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: onsiteCursor },
    { enabled: enabled && !isApproved, retry: false }
  );
  const offsiteApprovedQ = trpc.appListings.listApprovedRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: offsiteCursor },
    { enabled: enabled && isApproved, retry: false }
  );
  const offsiteRejectedQ = trpc.appListings.listRejectedRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: offsiteCursor },
    { enabled: enabled && !isApproved, retry: false }
  );

  const onsiteQuery = isApproved ? onsiteApprovedQ : onsiteRejectedQ;
  const offsiteQuery = isApproved ? offsiteApprovedQ : offsiteRejectedQ;

  const onsitePage = (onsiteQuery.data?.items ?? []) as OnsiteReviewRequest[];
  const offsitePage = (offsiteQuery.data?.items ?? []) as OffsiteReviewRequest[];

  const onsiteItems = useMemo(
    () => (onsiteCursor ? mergeById(onsiteAcc, onsitePage) : onsitePage),
    [onsiteAcc, onsitePage, onsiteCursor]
  );
  const offsiteItems = useMemo(
    () => (offsiteCursor ? mergeById(offsiteAcc, offsitePage) : offsitePage),
    [offsiteAcc, offsitePage, offsiteCursor]
  );

  const onsiteNext = onsiteQuery.data?.nextCursor ?? null;
  const offsiteNext = offsiteQuery.data?.nextCursor ?? null;

  const resetPaging = useCallback(() => {
    setOnsiteAcc([]);
    setOffsiteAcc([]);
    setOnsiteCursor(undefined);
    setOffsiteCursor(undefined);
  }, []);

  const boundOnsite = useCallback(
    // History rows open in read-only mode ('approved'/'rejected'), so the action bar
    // self-suppresses and onActioned never fires — but wire resetPaging for symmetry.
    (req: OnsiteReviewRequest) => openOnsiteReview(req, kind, resetPaging),
    [openOnsiteReview, kind, resetPaging]
  );
  const boundOffsite = useCallback(
    // Off-site history opens the modal READ-ONLY (no Approve/Reject buttons) — an
    // already-decided request would only error NOT_PENDING; this matches on-site.
    (row: OffsitePendingRow) => openOffsiteReview(row, resetPaging, true),
    [openOffsiteReview, resetPaging]
  );

  const onLoadMore = () => {
    if (onsiteNext != null) {
      setOnsiteAcc(onsiteItems);
      setOnsiteCursor(onsiteNext);
    }
    if (offsiteNext != null) {
      setOffsiteAcc(offsiteItems);
      setOffsiteCursor(offsiteNext);
    }
  };

  // APPROVED tab only — re-fire the build for an approved request whose build
  // never started (deploy state null) or failed. The mutation takes ONLY the
  // request id; the sha to rebuild is read server-side from the already-reviewed
  // DB row. Tracks the in-flight id so only that row's button spins/disables.
  const [retriggeringId, setRetriggeringId] = useState<string | null>(null);
  const retriggerMutation = trpc.blocks.retriggerBuild.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        message: 'Build re-triggered — the deploy state will update as it progresses.',
      });
      resetPaging();
      void onsiteApprovedQ.refetch();
    },
    onError: (e) =>
      showErrorNotification({ title: 'Re-trigger failed', error: new Error(e.message) }),
    onSettled: () => setRetriggeringId(null),
  });
  const onRetriggerBuild = useCallback(
    (publishRequestId: string) => {
      // Belt against a double-fire that slips past the button's own disabled state.
      if (retriggerMutation.isPending) return;
      setRetriggeringId(publishRequestId);
      retriggerMutation.mutate({ publishRequestId });
    },
    [retriggerMutation]
  );

  return (
    <UnifiedReviewList
      onsiteItems={onsiteItems}
      offsiteItems={offsiteItems}
      direction="desc"
      openOnsiteReview={boundOnsite}
      openOffsiteReview={boundOffsite}
      openVersionHistory={openVersionHistory}
      isLoading={onsiteQuery.isLoading || offsiteQuery.isLoading}
      errorMessage={onsiteQuery.error?.message ?? offsiteQuery.error?.message}
      emptyLabel={isApproved ? 'No approved requests yet.' : 'No rejected requests yet.'}
      dateLabel="Reviewed"
      actionLabel="View"
      hasMore={onsiteNext != null || offsiteNext != null}
      isLoadingMore={onsiteQuery.isFetching || offsiteQuery.isFetching}
      onLoadMore={onLoadMore}
      // Deploy column + retrigger control exist on the APPROVED tab only; the
      // Rejected tab passes neither and renders exactly as before.
      onRetriggerBuild={isApproved ? onRetriggerBuild : undefined}
      retriggeringId={retriggeringId}
    />
  );
}
