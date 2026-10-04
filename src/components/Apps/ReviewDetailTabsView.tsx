import { Stack, Tabs, Text } from '@mantine/core';
import { IconCode, IconFileCode, IconKey, IconRobot, IconWindow } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ManifestScopes,
  ManifestView,
  ReviewAgentSection,
  ReviewCurationSection,
  ReviewFilesSection,
  ReviewManifestDiffSection,
  ReviewPreviewSection,
  ScreenshotsReviewPanel,
  type OnsiteReviewSelection,
} from '~/components/Apps/OnsiteReviewModal';
import { ReviewListingMedia } from '~/components/Apps/ReviewListingMedia';
import {
  isReviewDetailTab,
  resolveReviewDetailTab,
  REVIEW_DETAIL_TAB_LABELS,
  REVIEW_DETAIL_TAB_QUERY_KEY,
  REVIEW_DETAIL_TAB_VALUES,
  reviewDetailTabQuery,
  type ReviewDetailTab,
} from '~/components/Apps/reviewDetailTabs';
import { appDisplayName } from '~/shared/utils/app-display-name';

/**
 * The per-submission review PAGE's body, as FIVE TABS with PERMISSIONS FIRST.
 *
 * ## What moved, and why
 *
 * The page used to re-host `OnsiteReviewModalBody` verbatim: one `Stack` running submitter →
 * decision alert → sandbox preview → agent report → screenshots → curation → files + code
 * diff → manifest diff → manifest. The declared SCOPES and their developer-supplied
 * justifications sat at the very BOTTOM of that scroll, inside the manifest card — and
 * judging whether a requested permission is justified is the moderator's primary job on
 * this surface. So the sections are regrouped and permissions lead.
 *
 * 🔴 THE SECTIONS ARE THE SHARED ONES, NOT COPIES. Every panel below is imported from
 * `OnsiteReviewModal`, which is also what the queue modal and `CombinedReviewModal` render.
 * The tab restructure is an ARRANGEMENT; a per-surface copy of a panel would drift, and the
 * drift would be invisible because each surface's own tests would stay green. See that
 * module's `OnsiteReviewModalBody` docstring.
 *
 * 🔴 THE TABS ARE URL-BACKED (`?tab=`), BECAUSE THAT IS THE PAGE'S REASON FOR EXISTING. Its
 * own module docstring calls it "deep-linkable, refresh-survivable". Tabs in local state
 * would regress exactly that. The resolver lives in `reviewDetailTabs.ts` (pure, node-env
 * testable); an unknown or absent value falls back to the default rather than rendering an
 * empty panel.
 *
 * 🔴 THE APPROVE/REJECT BAR IS NOT IN HERE. It stays outside the tabs, in
 * `ReviewDetailView`'s sticky bottom bar, so a mod can act from ANY tab without first
 * navigating back to the one that happens to hold the controls.
 */

/**
 * Per-tab icon. The labels live in `reviewDetailTabs.ts`, which is React-free.
 *
 * Typed as `typeof IconKey` rather than a hand-written `ComponentType<{size}>`: tabler's
 * icons are `ForwardRefExoticComponent`s whose `size` accepts `string | number`, so the
 * narrower hand-written signature does not accept them. Same form as
 * `ACTIVITY_TAB_ICONS` in `/apps/activity`.
 *
 * 🔴 EXPORTED SO THE LADLE STORY CANNOT DRIFT FROM THE REAL BAR. That story's docstring
 * claims it renders "the SAME tab values, labels and icons"; values and labels were imported
 * and the icons were re-declared, so changing one here left the preview — the surface whose
 * whole job is to look right — showing the old one.
 */
export const TAB_ICONS: Record<ReviewDetailTab, typeof IconKey> = {
  permissions: IconKey,
  code: IconCode,
  agent: IconRobot,
  manifest: IconFileCode,
  preview: IconWindow,
};

/**
 * Which tabs have been VISITED, so a panel mounts on first arrival and stays mounted.
 *
 * 🔴 NEITHER MANTINE `keepMounted` SETTING IS RIGHT HERE, WHICH IS WHY THIS EXISTS.
 *   · `keepMounted` (the default, `true`) mounts EVERY panel on every render — so landing on
 *     Permissions would still fire the screenshots fetch (base64 image payloads), the
 *     agent-report poll and the preview-status poll, for tabs the mod may never open.
 *   · `keepMounted={false}` unmounts a panel the moment you leave it — which destroys the
 *     Preview tab's `ReviewBlockPreviewHost` IFRAME. A mod running the pending app in the
 *     sandbox, stepping to Permissions to check a scope, and coming back would find the
 *     block reloaded and any in-app state gone.
 * Visit-once-then-keep gives both: nothing is fetched until the mod asks for that section,
 * and nothing they were working in is torn down behind them.
 */
function useVisitedTabs(active: ReviewDetailTab): ReadonlySet<ReviewDetailTab> {
  // A ref, not state: adding the first tab during the first render must not schedule a
  // second render, and the value is only ever read in the same render that grows it.
  const visited = useRef<Set<ReviewDetailTab>>(new Set([active]));
  visited.current.add(active);
  return visited.current;
}

function ReviewDetailTabsViewInner({
  selection,
}: {
  selection: NonNullable<OnsiteReviewSelection>;
}) {
  const router = useRouter();
  const { request } = selection;
  const manifest = request.manifest as Record<string, unknown>;

  /**
   * 🔴 THE HASH IS READ IN AN EFFECT, NOT DURING RENDER, and that is an SSR requirement
   * rather than a style choice: `window.location` does not exist on the server, and a value
   * that differs between the server render and the first client paint is a hydration
   * mismatch. So the first paint resolves from `?tab=` alone (which SSR *does* have, via
   * `getServerSideProps`), and the hash fallback — the thing that keeps `ReportTabs`'
   * existing `#finding-security-2` copy-links landing on the Agent report tab — applies
   * after mount.
   */
  const [hash, setHash] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setHash(window.location.hash);
  }, []);

  const rawTab = router.query[REVIEW_DETAIL_TAB_QUERY_KEY];
  const activeTab = useMemo(() => resolveReviewDetailTab(rawTab, { hash }), [rawTab, hash]);
  const visited = useVisitedTabs(activeTab);

  return (
    <Tabs
      value={activeTab}
      onChange={(value) => {
        if (!isReviewDetailTab(value)) return;
        /*
          🔴 `replace` + `shallow`, like `/apps/activity`: no re-run of `getServerSideProps`
          and no history entry per click (which would turn Back into a tab-by-tab rewind out
          of the submission).

          🔴 AND IT CANNOT TRIP THE PAGE'S ROUTE-LEAVE GUARD, because this is a QUERY-ONLY
          change. `useCatchNavigation`'s `handleBrowsingAway` compares
          `window.location.pathname` against the destination with its query stripped
          (`url.split('?')[0]`) and returns early when they are equal — so switching tabs
          mid-approve never prompts.

          ⚠️ THAT HALF IS A CODE-READING ARGUMENT, NOT A TEST, and is written as one
          deliberately. The premise it rests on — that a tab click produces a replace to the
          SAME pathname — IS tested (`ReviewDetailTabs.browser.test.tsx` asserts
          `url.pathname` is still `/apps/review/[publishRequestId]`). The early return itself
          cannot be exercised in the component harness: the guard reads the REAL
          `window.location.pathname`, which under vitest-browser is the runner's page, not the
          app route, so a faithful test there would be asserting the harness's URL rather than
          the guard's rule. Do not "fix" that by relaxing the guard to make it testable.
        */
        void router.replace(
          { pathname: router.pathname, query: reviewDetailTabQuery(value, router.query) },
          undefined,
          { shallow: true }
        );
      }}
      variant="outline"
      // Panels are mounted by `visited` above, so Mantine's own flag is irrelevant here;
      // pinned explicitly so a later Mantine default change cannot silently re-introduce
      // mount-everything.
      keepMounted
      data-testid="apps-review-detail-tabs"
    >
      {/* Scrollable on narrow — the list scrolls within itself, never overflowing the page. */}
      <Tabs.List style={{ flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden' }}>
        {REVIEW_DETAIL_TAB_VALUES.map((tab) => {
          const Icon = TAB_ICONS[tab];
          return (
            <Tabs.Tab key={tab} value={tab} leftSection={<Icon size={14} />}>
              {REVIEW_DETAIL_TAB_LABELS[tab]}
            </Tabs.Tab>
          );
        })}
      </Tabs.List>

      {/*
        PERMISSIONS — the default tab. `ManifestScopes` already groups SENSITIVE scopes
        first with warning emphasis and renders each scope's developer-supplied
        justification; what changed is that it is now the first thing on screen instead of
        the last thing in the manifest card. `ManifestView` below is passed
        `includeScopes={false}` so this card appears exactly once on the page.
      */}
      <Tabs.Panel value="permissions" pt="md">
        {visited.has('permissions') && (
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              What this version asks to be allowed to do, and the reason its developer gave. The
              platform does not verify these claims — your judgement is the gate.
            </Text>
            <ManifestScopes manifest={manifest} />
          </Stack>
        )}
      </Tabs.Panel>

      {/*
        CODE — the file summary plus the GitHub-shaped line diff.

        🔴 THE DIFF STAYS BEHIND ITS OWN SWITCH, and arriving on this tab does NOT fetch it.
        An earlier revision auto-opened it here; the diff response has no total-bytes cap
        (300 files × 256 KiB/side), so a mod who opened this tab only to read the file COUNTS
        paid the whole fetch. The panel is still `visited`-gated, so nothing is read at all
        until the mod comes here — the switch is the second, cheaper decision.
      */}
      <Tabs.Panel value="code" pt="md">
        {visited.has('code') && <ReviewFilesSection request={request} />}
      </Tabs.Panel>

      {/*
        AGENT REPORT — `ReviewAgentSection` carries the whole gate (on-site pending +
        the mod-only `appBlocksAgenticReview` flag, fail-closed), so this tab is simply
        empty for a submission that has no agent surface. An empty state is rendered
        rather than nothing at all: a tab that paints blank reads as broken.

        ⚠️ NESTED TABS: `ReportTabs` is itself tabbed (Scopes / Security audit / Code
        review). Flattening it into this bar was considered and rejected — see the note
        on `ReportTabs` usage in the PR — because those three are SUB-VIEWS of one report
        object with their own deep-link contract (`#finding-<tab>-<n>`), and hoisting them
        here would put three report-shaped tabs next to five submission-shaped ones with no
        visual grouping to say which is which. The outer bar is `variant="outline"` and the
        inner one is Mantine's default underline, so the two read as different levels.
      */}
      <Tabs.Panel value="agent" pt="md">
        {visited.has('agent') && (
          <ReviewAgentSection
            selection={selection}
            fallback={
              /*
                ⚠️ NO KIND WORD IN THIS COPY. The App-store kind label has exactly one
                source (`STANDALONE_KIND_LABEL`) and the previous generation of words for it
                is retired — `standaloneWordingCallSites.test.ts` reds on a user-facing
                string that carries one, and it caught an earlier draft of this sentence.
                The gate's kind clause is not what a mod needs told here anyway: "this
                submission has no agentic review" is.
              */
              <Text size="xs" c="dimmed" fs="italic" data-testid="apps-review-agent-empty">
                No agentic review on this submission. It runs on a PENDING bundle only, and only for
                reviewers it has been enabled for.
              </Text>
            }
          />
        )}
      </Tabs.Panel>

      {/* MANIFEST — the field-level diff, then the full structured manifest WITHOUT its
          permissions card (that card is the Permissions tab). */}
      <Tabs.Panel value="manifest" pt="md">
        {visited.has('manifest') && (
          <Stack gap="md">
            <ReviewManifestDiffSection request={request} />
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                Manifest
              </Text>
              <ManifestView manifest={manifest} includeScopes={false} />
            </Stack>
          </Stack>
        )}
      </Tabs.Panel>

      {/*
        PREVIEW — everything a mod LOOKS at: the mod-only review sandbox, the store-listing
        icon/cover, the publisher screenshots from the bundle, and (approved only) the
        marketplace curation controls.

        🔴 `ReviewListingMedia` IS DIFFERENT BYTES FROM THE SCREENSHOTS BESIDE IT. The icon
        and cover are `AppListing` columns, authored in the store form and never present in
        the submitted ZIP — so a mod approving a first version was approving a store card
        they had not seen. Both belong on this tab; neither replaces the other.
      */}
      <Tabs.Panel value="preview" pt="md">
        {visited.has('preview') && (
          <Stack gap="md">
            <ReviewPreviewSection selection={selection} />
            <ReviewListingMedia
              slug={request.slug}
              name={appDisplayName(request.manifest, request.slug)}
              iconUrl={request.iconUrl ?? null}
              coverUrl={request.coverUrl ?? null}
            />
            <ScreenshotsReviewPanel publishRequestId={request.id} size="review" />
            <ReviewCurationSection selection={selection} />
          </Stack>
        )}
      </Tabs.Panel>
    </Tabs>
  );
}

/**
 * ⚠️ THE QUEUE MODAL HAS NO EQUIVALENT, AND IT RENDERS THE SAME PANELS. `OnsiteReviewModalBody`
 * calls the same `useNowTick` and then renders `ReviewAgentSection` / `ReviewFilesSection` as
 * flat siblings with nothing memoised between the tick and them — so the per-minute re-render
 * described below is still live there. That is accepted for now (mod-only, one submission
 * open at a time), but `OnsiteReviewModalBody`'s docstring forbids forking a panel for one
 * surface — one implementation, rendered by both, differing only in arrangement, and THIS is the one thing that is
 * not shared. Said here so the next reader does not assume `ReviewDetailTabsMemo`'s test
 * covers the modal; it does not.
 *
 * 🔴 MEMOISED, AND THE REASON IS THE CLOCK ONE LEVEL UP. `ReviewDetailView` owns a 60-second
 * tick so the submitter line and the decision banner can re-render their relative ages. Those
 * two are SIBLINGS of this subtree, but nothing between them is memoised — so every minute,
 * to change one "3h ago" string, React re-rendered every mounted panel: up to 300 collapsed
 * file cards, and every OPEN diff table's full row set (the `useMemo`s preserve the row
 * ARRAYS, not the elements, so each `<tr>`/`<td>`/`<Text>` is recreated and reconciled —
 * ~2,000 Mantine components per open file at the per-file cap, 4,000 in split).
 *
 * `selection` is the only prop and it does not change on a tick, so this cuts the tick's
 * blast radius to the two components that actually consume `now`.
 */
export const ReviewDetailTabsView = memo(ReviewDetailTabsViewInner);
