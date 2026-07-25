import { Tabs } from '@mantine/core';
import {
  IconCheck,
  IconClipboardList,
  IconClock,
  IconFlag,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
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
import { UnifiedReviewList } from '~/components/Apps/UnifiedReviewList';
import type {
  OffsiteReviewRequest,
  OnsiteReviewRequest,
} from '~/components/Apps/unifiedReviewRow';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
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
    v === 'pending' ||
    v === 'approved' ||
    v === 'rejected' ||
    v === 'reports' ||
    v === 'manage'
  );
}

/** Rows fetched per source per page (bounded by each proc's schema at ≤100). Mod
 *  queues are low/moderate volume, so one bounded page per source + Load-more is
 *  simple and correct. */
const PAGE_LIMIT = 50;

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

  if (!features?.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="App publish-request queue — Civitai" deIndex />
      <AppsPageLayout
        size="xl"
        title="App publish-request queue"
        subtitle="Moderator review for Apps. On-site + external submissions share one queue per tab; Pending is oldest-first, history is newest-first."
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

function UnifiedPendingTab({
  openOnsiteReview,
  openOffsiteReview,
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
}) {
  const features = useFeatureFlags();
  const enabled = !!features?.appBlocks;

  const [onsiteCursor, setOnsiteCursor] = useState<string | undefined>(undefined);
  const [offsiteCursor, setOffsiteCursor] = useState<string | undefined>(undefined);
  const [onsiteAcc, setOnsiteAcc] = useState<OnsiteReviewRequest[]>([]);
  const [offsiteAcc, setOffsiteAcc] = useState<OffsiteReviewRequest[]>([]);

  const onsiteQuery = trpc.blocks.listPendingRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: onsiteCursor },
    { enabled, retry: false }
  );
  const offsiteQuery = trpc.appListings.listPendingRequests.useQuery(
    { limit: PAGE_LIMIT, cursor: offsiteCursor },
    { enabled, retry: false }
  );

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

  return (
    <UnifiedReviewList
      onsiteItems={onsiteItems}
      offsiteItems={offsiteItems}
      direction="asc"
      openOnsiteReview={boundOnsite}
      openOffsiteReview={boundOffsite}
      isLoading={onsiteQuery.isLoading || offsiteQuery.isLoading}
      errorMessage={onsiteQuery.error?.message ?? offsiteQuery.error?.message}
      emptyLabel="Queue is empty. Nothing waiting for review."
      dateLabel="Submitted"
      actionLabel="Review"
      hasMore={onsiteNext != null || offsiteNext != null}
      isLoadingMore={onsiteQuery.isFetching || offsiteQuery.isFetching}
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
    />
  );
}
