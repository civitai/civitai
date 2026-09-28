import { Button, Group, Stack, Tabs, Text } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import {
  IconCheck,
  IconClipboardList,
  IconClock,
  IconFlag,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ActivePreviewsPanel } from '~/components/Apps/ActivePreviewsPanel';
import { AppListingsModerationTable } from '~/components/Apps/AppListingsModerationTable';
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
import { UnifiedReviewList } from '~/components/Apps/UnifiedReviewList';
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
 * Five tabs:
 *  - Pending  — ONE oldest-first FIFO list interleaving on-site publish requests
 *               (`blocks.listPendingRequests`) + off-site requests
 *               (`appListings.listPendingRequests`). Each row carries a kind badge
 *               (App / External) and a Review action that opens the CORRECT modal.
 *  - Approved — unified newest-first history (on-site + off-site approved requests).
 *  - Rejected — unified newest-first history (on-site + off-site rejected requests).
 *  - Reports  — off-site listing report queue + mod takedown actions (unchanged).
 *  - Manage listings — the full all-status lifecycle table (reset/relist/claim/purge).
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
    return { props: {} };
  },
});

type TabValue = 'pending' | 'approved' | 'rejected' | 'reports' | 'manage';

function isTabValue(v: unknown): v is TabValue {
  return (
    v === 'pending' || v === 'approved' || v === 'rejected' || v === 'reports' || v === 'manage'
  );
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

/**
 * Poll the visible queue, but stop dead on error and while paged past page 1.
 *
 * 🔴 BOTH REFUSALS ARE LOAD-BEARING, and neither is defensiveness:
 *
 *  • `hasError` — the two pending procs run with `retry: false`, and a moderator whose
 *    session has lost the reviewer role gets a hard `UNAUTHORIZED`. A fixed interval
 *    would re-fire that guaranteed-dead request every 15s forever. Same shape as
 *    `ActivePreviewsPanel`'s `refetchInterval: (q) => (q.state.error ? false : 30000)`.
 *    ⚠️ THIS REFUSAL IS FOR THE INTERVAL ONLY. The focus trigger deliberately does not
 *    apply it — see `focusDecision` at the call site — because doing so left a query
 *    that hit a one-off 502 permanently parked with no automatic route back. Resume is
 *    therefore a tab reveal or the explicit Refresh control, not Refresh alone.
 *
 *  • `hasCursor` — `cursor` is part of the tRPC query key, so after "Load more" the
 *    page-1 query is UNMOUNTED and the `onsiteAcc` / `offsiteAcc` accumulators holding
 *    its rows are frozen React state. A poll at that point would refresh only the
 *    LAST-loaded page while every earlier page silently went stale — strictly worse than
 *    not polling, because the list would look live and be partly frozen. Auto-refresh is
 *    therefore live in the DEFAULT view only (one 50-row page per source covers this
 *    queue) and yields to explicit paging; Refresh resets back to page 1.
 *
 * Exported and pure so the decision is unit-testable without a query client — the same
 * shape as `computeAgentReviewPollInterval` in `~/components/Apps/AgentReviewPanel`.
 *
 * ⚠️ The return type is `number | false`, and `false` is the value to use — but NOT because
 * `0` would poll "as fast as possible". It would not: `#updateRefetchInterval`
 * (query-core 5.101.0 `queryObserver.js:211`) returns early on `=== 0` exactly as it does
 * for `false`, and `#computeRefetchInterval` coerces `undefined` to `false` at `:206`, so
 * all three are "no timer" today. `false` is required because it is the only one of the
 * three that is unambiguous at every call site and in the exported type — a `0` reads as
 * a cadence someone forgot to fill in, and `undefined` reads as "not configured". An
 * earlier revision of this paragraph asserted the as-fast-as-possible behaviour as fact;
 * it was wrong, and a reviewer who checked it would have concluded the guard was
 * pointless. The unit test pins `false` specifically, which is the contract that survives
 * a version bump changing any of that.
 */
export function computeReviewQueuePollInterval(input: {
  hasError: boolean;
  hasCursor: boolean;
}): number | false {
  if (input.hasError || input.hasCursor) return false;
  return APPS_REVIEW_POLL_MS;
}

/** Append `page` onto `accumulated`, dropping ids already present (defensive dedup
 *  in case Load-more double-fires before a fetch settles). */
function mergeById<T extends { id: string }>(accumulated: T[], page: T[]): T[] {
  const seen = new Set(accumulated.map((r) => r.id));
  return [...accumulated, ...page.filter((r) => !seen.has(r.id))];
}

export default function ReviewQueuePage() {
  const features = useFeatureFlags();
  const router = useRouter();

  // Sync active tab with `?tab=` so deep-links land on the right view. Shallow
  // routing so the page query doesn't re-trigger getServerSideProps.
  const tab: TabValue = useMemo(() => {
    const qt = router.query.tab;
    if (typeof qt === 'string' && isTabValue(qt)) return qt;
    return 'pending';
  }, [router.query.tab]);

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
          </Tabs.List>

          <Tabs.Panel value="pending" pt="md">
            {/* ONE unified oldest-first queue: on-site + off-site pending requests. */}
            <UnifiedPendingTab
              openOnsiteReview={openOnsiteReview}
              openOffsiteReview={openOffsiteReview}
              openCombinedReview={openCombinedReview}
            />
          </Tabs.Panel>

          <Tabs.Panel value="approved" pt="md">
            <UnifiedHistoryTab
              kind="approved"
              openOnsiteReview={openOnsiteReview}
              openOffsiteReview={openOffsiteReview}
            />
          </Tabs.Panel>

          <Tabs.Panel value="rejected" pt="md">
            <UnifiedHistoryTab
              kind="rejected"
              openOnsiteReview={openOnsiteReview}
              openOffsiteReview={openOffsiteReview}
            />
          </Tabs.Panel>

          <Tabs.Panel value="reports" pt="md">
            {/* Off-site listing REPORT queue + mod takedown actions. Unchanged. */}
            <OffsiteReportsQueue />
          </Tabs.Panel>

          <Tabs.Panel value="manage" pt="md">
            {/* Full all-status listings MANAGEMENT table (reset/relist/claim/purge).
                Its pending rows' Review action opens the same page-owned off-site
                modal; its lifecycle-action modals stay local to it. */}
            <AppListingsModerationTable openOffsiteReview={openOffsiteReview} />
          </Tabs.Panel>
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
 * (`pendingAction` above), not about a pure function, so
 * `src/tests/pages/apps/review/review-queue-poll.browser.test.tsx` renders it directly. Nothing in the
 * app imports it; it stays page-local by convention. A named export alongside a page's
 * default is ordinary here (`src/pages/apps/activity.tsx`, `src/pages/home/index.tsx`).
 */
export function UnifiedPendingTab({
  openOnsiteReview,
  openOffsiteReview,
  openCombinedReview,
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
}) {
  const features = useFeatureFlags();
  const enabled = !!features?.appBlocks;
  const utils = trpc.useUtils();

  const [onsiteCursor, setOnsiteCursor] = useState<string | undefined>(undefined);
  const [offsiteCursor, setOffsiteCursor] = useState<string | undefined>(undefined);
  const [onsiteAcc, setOnsiteAcc] = useState<OnsiteReviewRequest[]>([]);
  const [offsiteAcc, setOffsiteAcc] = useState<OffsiteReviewRequest[]>([]);

  /**
   * 🔴 WHICH EXPLICIT, USER-INITIATED FETCH IS IN FLIGHT — `null` MEANS EVERY FETCH
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
   * 🔴 THE TWO ACTIONS ARE CLEARED BY DIFFERENT SIGNALS, AND THAT IS NOT AN INCONSISTENCY.
   * "Load more" moves a cursor, which is part of the tRPC query key, so the new query is
   * already fetching on the very next render — `!anyFetching` is a true settle signal for
   * it. "Refresh" is not: `invalidate()` starts its refetch asynchronously, so the render
   * immediately after the click still reports NOTHING fetching, and a shared
   * `!anyFetching` rule would clear the flag before the spinner ever appeared — the
   * control would be dead code that renders in no reachable state. Refresh is therefore
   * cleared by its own `invalidate()` promises resolving, which is the event it is
   * actually waiting on. Neither can stick: the effect below fails open, and those
   * promises always settle.
   *
   * ⚠️ IF THIS TAB IS EVER MOVED TO `useInfiniteQuery`, DELETE THE `'loadMore'` ARM RATHER
   * THAN PORTING IT — `isFetchingNextPage` IS THIS, FROM THE LIBRARY.
   * `infiniteQueryObserver.js` derives it as `isFetching && fetchDirection === 'forward'`,
   * and `fetchDirection` is set only by a `fetchNextPage()` call, so it is already false
   * for a poll, a focus refetch and an invalidate — exactly the discrimination the
   * paragraph above hand-rolls. Both procs already satisfy the contract with no server
   * change (optional `cursor` in, `nextCursor` out), and the moderator-queue idiom is
   * `src/pages/moderator/challenges.tsx`. That switch also dissolves `refreshNonce` below
   * (nothing to batch behind once the cursors stop being React state) and REFRAMES the
   * `hasCursor` refusal: `infiniteQueryBehavior.js` re-fetches every loaded page from the
   * first on an undirected refetch, so the "a poll refreshes only the LAST page" argument
   * is a property of THIS hand-rolled accumulator, not of polling — the gate would survive
   * as a cost choice (N sequential requests per source per tick), which is a smaller and
   * different claim than the one documented on the helper. Deliberately NOT done in this
   * PR: it is a rewrite of the tab's paging, not an addition of auto-refresh, and it would
   * leave Pending and History on two different paging mechanisms.
   */
  const [pendingAction, setPendingAction] = useState<'loadMore' | 'refresh' | null>(null);

  /**
   * 🔴 THE CURSOR GATE IS A PROPERTY OF THE MERGED LIST, SO IT IS THE **OR** OF BOTH
   * SOURCES — NOT EACH QUERY'S OWN CURSOR.
   *
   * The two sources are independently keyset-paginated and are almost never the same
   * depth, so "Load more" routinely advances one and leaves the other alone (a source
   * whose `nextCursor` is already null never moves). With a per-source gate, that parks
   * the paged source and leaves the OTHER one polling — which produces exactly the state
   * `computeReviewQueuePollInterval`'s own docblock exists to prevent: a single list whose
   * off-site rows are live and whose on-site rows are frozen accumulator state, looking
   * current and being half stale. One page of either source is enough to make the whole
   * list partly frozen, so the whole list stops polling.
   */
  const hasAnyCursor = onsiteCursor != null || offsiteCursor != null;

  /**
   * The poll decision for ONE source: this query's own error, plus the shared cursor state.
   *
   * 🔴 ONE PLACE THE ARGUMENTS ARE ASSEMBLED, because there are SIX consumers of this
   * decision — `refetchInterval` and `refetchOnWindowFocus` on each of two queries, plus
   * the two the status row makes — and an argument list written out six times is a
   * predicate waiting to disagree with itself. It already did once: the status row used to
   * build its own `hasCursor` from an OR while the queries each used their own cursor, and
   * the two contradicted each other in a state a moderator reaches by clicking Load more.
   *
   * The ERROR half stays per-query on purpose. Its job is to stop re-firing a request that
   * is guaranteed to fail, which is a fact about THAT endpoint, not about the merged list —
   * same shape as `ActivePreviewsPanel`'s `refetchInterval: (q) => (q.state.error ? false :
   * 30000)`. The CURSOR half is shared, because being paged is a fact about the list. The
   * status row is what reconciles the two sources for the reader.
   */
  const pollDecision = (hasError: boolean) =>
    computeReviewQueuePollInterval({ hasError, hasCursor: hasAnyCursor });

  /**
   * 🔴 `'always'`, NOT `true`, AND THE DIFFERENCE IS THE WHOLE OPTION.
   *
   * A deliberate per-query override of the repo-wide `refetchOnWindowFocus: false` in
   * `src/utils/trpc.ts`: coming back to the tab is the strongest signal a mod is about to
   * act on this list, and a stale row is exactly what gets mis-clicked. But the repo ALSO
   * sets `staleTime: Infinity` there, and `true` is gated on staleness — `shouldFetchOn`
   * (query-core 5.101.0 `queryObserver.js:450-456`) returns `value === 'always' || (value
   * !== false && isStale(...))`, and `isStale` is `query.isStaleByTime(Infinity)`, which is
   * `false` whenever the query holds data and is not invalidated. So `true` would have been
   * INERT in precisely the state it was added for — firing only before the first successful
   * load. `'always'` short-circuits ahead of that check.
   *
   * ⚠️ `src/hooks/useIsLive.ts` pairs the option with an explicit `staleTime` instead, and
   * that is NOT equivalent — it is the nearest precedent, not the same behaviour. `true` +
   * a finite `staleTime` DEDUPES rapid refocus; `'always'` refetches on every
   * hidden→visible transition. The difference is negligible for two low-volume queries at
   * human alt-tab speed, and it is stated rather than glossed because it is a real
   * behavioural divergence from the simpler form.
   *
   * 🔴 IT IS THE CALLBACK FORM BECAUSE `'always'` SHORT-CIRCUITS THE CURSOR GATE TOO, AND
   * THAT ONE MUST SURVIVE. Taken bare, a queue paged past page 1 would refresh only its
   * last-loaded page on every tab reveal, which is exactly the half-frozen list the cursor
   * gate refuses. So the cursor refusal is passed through to this trigger unchanged.
   *
   * 🔴 BUT THE ERROR REFUSAL IS DELIBERATELY *NOT* — `hasError: false` BELOW IS THE POINT
   * OF THIS FUNCTION, NOT AN OVERSIGHT. The two refusals belong to different triggers:
   *
   *   • The error gate exists to stop a TIMER re-firing a dead request on the order of
   *     5,000+ times a day (nearer 5,400-5,700 than the nominal 5,760: `#updateTimers`
   *     clears and restarts the interval on every query state dispatch, so the real
   *     cadence is 15s after the LAST state change, i.e. 15s + RTT per cycle). That
   *     argument is about the interval and does not transfer: a focus refetch is bounded
   *     by human alt-tab rate, order tens per day.
   *   • Applied here it removed the ONLY automatic recovery this queue had. Once a query
   *     errors — including a one-off 502, which the gate cannot tell from a permanent
   *     `UNAUTHORIZED` — every route back is closed: the interval is cleared;
   *     `refetchOnReconnect` resolves through `value !== false && isStale(…)` and a query
   *     holding data under `staleTime: Infinity` is never stale; and remounting the tab
   *     does nothing because `shouldLoadOnMount` (`queryObserver.js:444-446`) requires
   *     `state.data === undefined`, which a previously-working poll never satisfies.
   *     `state.error` is only cleared by a successful fetch, so the exit was Refresh or a
   *     full reload — permanently parked on a blip.
   *
   * A tab reveal is therefore allowed to retry an errored query. `retry: false` keeps that
   * to one attempt, the status row still reads "paused" until it succeeds, and Refresh
   * remains the explicit path. This is the one place the two triggers diverge, which is
   * why the divergence is a literal argument rather than a different helper.
   *
   * `refetchIntervalInBackground` stays UNSET. ⚠️ Precisely: the TIMER is not paused —
   * `#updateRefetchInterval` (`queryObserver.js:208-219`) keeps a plain `setInterval` and
   * the CALLBACK skips the fetch while the document is hidden. Nothing here depends on the
   * difference, but do not reason from it that returning to a tab restarts the cadence
   * from zero; it does not.
   */
  const focusDecision = () =>
    computeReviewQueuePollInterval({ hasError: false, hasCursor: hasAnyCursor }) === false
      ? (false as const)
      : ('always' as const);

  const onsiteQuery = trpc.blocks.listPendingRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: onsiteCursor },
    {
      enabled,
      retry: false,
      // The callback form, not a bare number — it is the only one that can read this
      // query's own error state.
      refetchInterval: (query) => pollDecision(!!query.state.error),
      refetchOnWindowFocus: () => focusDecision(),
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
       * That is a pre-existing defect, but the `pendingAction` work above would have
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
      // Identical wiring to the on-site query above; the reasoning lives on `pollDecision`,
      // `focusDecision` and the `placeholderData` docblock rather than being restated here.
      refetchInterval: (query) => pollDecision(!!query.state.error),
      refetchOnWindowFocus: () => focusDecision(),
      placeholderData: keepPreviousData,
    }
  );

  const anyFetching = onsiteQuery.isFetching || offsiteQuery.isFetching;
  useEffect(() => {
    // Load-more only: clear as soon as the pair is idle again. Deliberately
    // one-directional — nothing here ever SETS the flag, so a background fetch can never
    // turn a control into a spinner. `'refresh'` is excluded because its fetch has not
    // started yet at this point; see `onRefresh` and the docstring on `pendingAction`.
    if (pendingAction === 'loadMore' && !anyFetching) setPendingAction(null);
  }, [pendingAction, anyFetching]);

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

  /**
   * The explicit Refresh: back to page 1 AND actually re-fetch it.
   *
   * 🔴 `resetPaging()` ALONE IS NOT A REFRESH, in either of the two states that matter.
   * In the default view the cursors are already `undefined`, so every setter is a no-op,
   * no state changes and nothing re-fetches — the button would do literally nothing. And
   * after paging, resetting the cursors swaps in a page-1 query the repo-wide
   * `staleTime: Infinity` (`src/utils/trpc.ts`) considers permanently fresh, so it would
   * serve the ORIGINAL page 1 rather than current rows. `invalidate()` is what closes
   * both: it marks the cached pages stale and re-fetches the ACTIVE ones, which is also
   * what makes this the resume path for a query the poll has parked on an error.
   *
   * 🔴 THE INVALIDATE IS DEFERRED TO AN EFFECT, AND THAT IS NOT CEREMONY. React batches
   * the four `resetPaging` setters until the handler returns, so an `invalidate()` called
   * beside them runs while the query carrying the OLD cursor is still the active one —
   * `refetchType: 'active'` then re-fetches the page the very next render is about to
   * discard. Two requests per source instead of one, and worse: the promise this control
   * settles on resolves on the ABANDONED page's fetch, so the spinner clears before page
   * 1 has arrived. Running it in an effect means the cursor reset has already committed,
   * so there is exactly one active query per source — page 1 — and it is both the thing
   * fetched and the thing awaited.
   */
  const [refreshNonce, setRefreshNonce] = useState(0);
  const onRefresh = useCallback(() => {
    resetPaging();
    setRefreshNonce((n) => n + 1);
  }, [resetPaging]);

  useEffect(() => {
    if (refreshNonce === 0) return;
    setPendingAction('refresh');
    // `invalidate()` resolves when the refetch it triggered has completed, so awaiting the
    // pair IS the settle signal for this control — and `allSettled` means a rejected
    // refetch clears it too rather than leaving the button disabled forever. The
    // functional update is so a Load-more begun in the meantime is not stamped out.
    void Promise.allSettled([
      utils.blocks.listPendingRequests.invalidate(),
      utils.appListings.listPendingRequests.invalidate(),
    ]).finally(() => setPendingAction((current) => (current === 'refresh' ? null : current)));
    // `utils` is a stable proxy; the nonce is the only real trigger. Deliberately NOT
    // depending on anything else — this must fire once per click, never on a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

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
    setPendingAction('loadMore');
  };

  /**
   * What the STATUS ROW is allowed to claim.
   *
   * 🔴 IT CALLS `pollDecision` — THE SAME FUNCTION THE TWO QUERIES DO, ONCE PER SOURCE —
   * so it cannot recompute the rule or assemble the arguments differently. An earlier
   * revision open-coded a second, subtly different predicate here, and the two disagreed
   * in a state a moderator reaches routinely. One rule, one place; this reads it rather
   * than restating it.
   *
   * 🔴 AND IT HAS THREE OUTCOMES, NOT TWO, BECAUSE THE SOURCES CAN GENUINELY DISAGREE.
   * The cursor gate is now global, so a split can only come from ONE source erroring —
   * and there the honest answer is neither "auto-refreshing" nor "paused". Getting this
   * wrong is not cosmetic: rows here are whole-row-clickable
   * (`~/components/Apps/UnifiedReviewList`), and the repaint-under-the-cursor risk was
   * accepted on the basis that the row TELLS the moderator repaints are happening. A row
   * reading "paused" over a list that is still half-repainting silently withdraws that
   * warning while the hazard continues.
   */
  const sourcePolls = [pollDecision(!!onsiteQuery.error), pollDecision(!!offsiteQuery.error)];
  const livePolls = sourcePolls.filter((interval): interval is number => interval !== false);
  const pollStatus =
    livePolls.length === sourcePolls.length
      ? `Auto-refreshing every ${livePolls[0] / 1000}s`
      : livePolls.length === 0
      ? 'Auto-refresh paused — use Refresh.'
      : 'Auto-refreshing part of the queue — use Refresh.';

  return (
    <Stack gap="md">
      {/* A QUIET status row — `xs`/dimmed, above the list, so the auto-refresh is
          discoverable without competing with the queue itself. Mirrors the
          poll-cadence line + Refresh button on `src/pages/moderator/resource-load.tsx`.

          🔴 The Refresh button carries NO `loading` prop tied to `isFetching`. That is
          the same trap as the Load-more one documented on `pendingAction`: with a 15s
          poll, `isFetching` (and `isRefetching`) go true on every background cycle, so a
          spinner bound to it would pulse on an untouched page. It spins only for the
          refresh the mod actually asked for. */}
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="xs" c="dimmed" data-testid="apps-review-poll-status">
          {pollStatus}
        </Text>
        <Button
          variant="subtle"
          size="compact-xs"
          leftSection={<IconRefresh size={14} />}
          onClick={onRefresh}
          loading={pendingAction === 'refresh'}
          data-testid="apps-review-refresh"
        >
          Refresh
        </Button>
      </Group>

      <UnifiedReviewList
        onsiteItems={onsiteItems}
        offsiteItems={offsiteItems}
        direction="asc"
        openOnsiteReview={boundOnsite}
        openOffsiteReview={boundOffsite}
        openCombinedReview={boundCombined}
        isLoading={onsiteQuery.isLoading || offsiteQuery.isLoading}
        errorMessage={onsiteQuery.error?.message ?? offsiteQuery.error?.message}
        emptyLabel="Queue is empty. Nothing waiting for review."
        dateLabel="Submitted"
        actionLabel="Review"
        hasMore={onsiteNext != null || offsiteNext != null}
        // 🔴 NOT `isFetching` — see `pendingAction`. A background poll must not disable
        // this button.
        isLoadingMore={pendingAction === 'loadMore'}
        onLoadMore={onLoadMore}
      />
    </Stack>
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
}: {
  kind: 'approved' | 'rejected';
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
