/**
 * `/apps/review` PENDING TAB — A BACKGROUND POLL MUST NOT DISABLE "LOAD MORE".
 *
 * 🔴 THE DEFECT THIS PINS, AND WHY IT ARRIVES WITH THE POLL RATHER THAN BEFORE IT.
 * The tab used to pass `isLoadingMore={onsiteQuery.isFetching || offsiteQuery.isFetching}`
 * to `UnifiedReviewList`, and `UnifiedReviewList` feeds that straight into the Load-more
 * `Button`'s `loading` AND `disabled`. `isFetching` does not distinguish a foreground
 * fetch from a background one — so as soon as the queue started polling every 15s, that
 * button would drop into a spinner and go un-clickable for the length of every poll, on a
 * page nobody had touched. The prop was harmless while nothing refetched on its own; the
 * poll is what makes it a bug, which is exactly the kind of defect a one-line
 * `refetchInterval` diff hides.
 *
 * 🔴 THE TEST IS A DISCRIMINATION, NOT AN ABSENCE. Both cases below feed the component
 * the SAME `isFetching: true` — the one and only input the old code looked at. What
 * differs is whether the moderator clicked. An implementation that reads `isFetching`
 * passes the "clicked" case and fails the "background" one; an implementation that never
 * shows a spinner at all passes the background case and fails the clicked one. Only the
 * real state machine satisfies both, so neither assertion can be dropped without the
 * other going red.
 *
 * The trpc surface is mocked with the spread-and-override form (`local-rules/
 * no-wholesale-module-mock`); `~/server/utils/server-side-helpers` is stubbed because the
 * unit under test lives in the page module, which declares `getServerSideProps` and would
 * otherwise drag the tRPC SERVER graph into a browser bundle. Neither stub is under test.
 *
 * 🔴 THIS FILE IS A LOCAL INSTRUMENT, NOT AN ENFORCED GATE — RUN IT YOURSELF. It is a
 * `*.browser.test.tsx`, so `vitest.config.mts` collects it into the `component` project,
 * and no selector in `.github/workflows/lint.yml` names that project: the workflow runs
 * `--project 'unit*'`, `--project geometry` and the workspace `packages`/`apps` configs,
 * none of which can claim this glob. Its only CI home is the preview pipeline's
 * `preview / component-tests` status, which is report-only and non-blocking. So nothing
 * here will stop a regression reaching `main` on its own; it catches things for whoever
 * runs it. Widening the component tier into a blocking job is a real change with its own
 * cost argument and belongs in its own PR — do not bolt it on here. Run it with:
 *   pnpm exec vitest run --project component src/tests/pages/apps/review/review-queue-poll.browser.test.tsx
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import, at the
// same depth as the sibling suites in this directory.
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
// Top-level type imports, not inline `import()` annotations — the latter are banned by
// `@typescript-eslint/consistent-type-imports`.
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as IsClientMod from '~/providers/IsClientProvider';
import type * as CurrentUserMod from '~/hooks/useCurrentUser';

type QueryOpts = {
  /**
   * 🔴 A VALUE, NOT A CALLBACK. The interval used to be `(query) => …` so it could read
   * that query's own error and park on it; dropping the error gate left nothing per-query
   * for it to read, so it is now a plain number.
   *
   * ⚠️ AN EARLIER DRAFT ENDED "and the type is the assertion — a mutation that restores
   * the callback form fails to type-check here before any assertion runs". IT DOES NOT,
   * for the reason given on the sibling option below: `vi.mock`'s string-path overload
   * types its factory as `Partial<unknown>`, so this local `QueryOpts` never constrains
   * the page at all. Measured: `refetchInterval: () => APPS_REVIEW_POLL_MS` on both
   * queries type-checks CLEAN, and is caught instead by the runtime assertions — 3 of
   * these tests go red. The coverage is real; the mechanism was misdescribed. (The
   * sibling below was corrected first and this one was left standing, which is the
   * sweep-every-site lesson: a retraction is a sweep, not an edit at the site you were
   * looking at.)
   */
  refetchInterval?: number | false;
  /**
   * 🔴 A VALUE HERE TOO, AND FOR THE SECOND HALF OF THE SAME REASON. This was a
   * `(query) => …` callback so the cursor gate could be applied before the value was
   * chosen; with that gate deleted there is nothing per-query left to decide, so the
   * option is the bare string.
   *
   * ⚠️ AN EARLIER DRAFT CLAIMED A MUTATION RESTORING THE CALLBACK FORM "fails to
   * type-check before any assertion runs". IT DOES NOT, and the distinction matters
   * because it names the wrong guard. `vi.mock`'s string-path overload types its factory
   * as `Partial<unknown>`, so this local `QueryOpts` never constrains the page at all —
   * the page is checked against react-query's own option type, which accepts a callback.
   * What actually catches the mutation is the RUNTIME assertion below, measured: setting
   * `refetchOnWindowFocus: true` on both queries turns 2 of these tests red. The coverage
   * is real; only the mechanism was misdescribed.
   */
  refetchOnWindowFocus?: boolean | 'always';
  placeholderData?: unknown;
};

/** The two pending queries' results, mutated by each test before a forced re-render. */
const { queryState, capturedOpts, capturedInput } = vi.hoisted(() => ({
  queryState: {
    onsite: {
      // `as string | null` on BOTH sources: the inverted-fixture arm exhausts the on-site
      // source, and without the widening its inferred type is the literal string.
      data: { items: [] as unknown[], nextCursor: 'onsite-cursor-2' as string | null },
      isLoading: false,
      isFetching: false,
      error: null as { message: string } | null,
    },
    offsite: {
      data: { items: [] as unknown[], nextCursor: null as string | null },
      isLoading: false,
      isFetching: false,
      error: null as { message: string } | null,
    },
  },
  /**
   * The OPTIONS object each query was handed. The whole feature is options — a
   * `refetchInterval` and a `refetchOnWindowFocus` — and a mock that drops the second
   * argument can see none of it: delete both from the source and every behavioural test
   * here still passes over a queue that never polls. Capturing them, then reading the
   * value / CALLING the captured callback, is what makes the wiring observable. Same shape
   * as `AgentReviewPanel.browser.test.tsx`, which captures `mocks.lastAgentOpts`.
   */
  capturedOpts: {
    onsite: null as QueryOpts | null,
    offsite: null as QueryOpts | null,
  },
  /**
   * The INPUT each query was handed — i.e. its tRPC query key. The options tell you what
   * the component decided; this tells you which PAGE it is asking for, which is the only
   * direct evidence that a cursor actually advanced and actually reset.
   */
  capturedInput: {
    onsite: null as { limit: number; cursor?: string } | null,
    offsite: null as { limit: number; cursor?: string } | null,
  },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
// Spread-and-override throughout: the page module's import graph is much wider than a
// single component's, and a wholesale replacement drops the other exports its siblings
// need (`useOptionalFeatureFlags` is imported somewhere down this graph, and a bare
// factory for this module fails the whole file's import with `does not provide an export
// named …`). It is also what `local-rules/no-wholesale-module-mock` asks for.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));
vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClientMod>()),
  useIsClient: () => true,
}));
// Stubbed: `UserAvatar` calls `trpc.user.getById.useQuery` unconditionally, and this
// file's `trpc` override names only the two queue procs — so the real avatar takes the
// whole tab down. Precedent: `~/components/Reaction/ImageReactorsPreview.browser.test.tsx`.
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({ user }: { user: { id: number; username?: string | null } }) => (
    <span>{user.username ?? `#${user.id}`}</span>
  ),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUserMod>()),
  useCurrentUser: () => ({ id: 1, username: 'mod', isModerator: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    blocks: {
      listPendingRequests: {
        useQuery: (input: { limit: number; cursor?: string }, opts: QueryOpts) => {
          capturedOpts.onsite = opts;
          capturedInput.onsite = input;
          return queryState.onsite;
        },
      },
    },
    appListings: {
      listPendingRequests: {
        useQuery: (input: { limit: number; cursor?: string }, opts: QueryOpts) => {
          capturedOpts.offsite = opts;
          capturedInput.offsite = input;
          return queryState.offsite;
        },
      },
    },
  },
}));

const { UnifiedPendingTab } = await import('~/pages/apps/review');

/**
 * Lets a test mutate `queryState` and then make the component read it again.
 *
 * The tab is wrapped in a `tab-under-test` element so the zero-extra-chrome test can scope
 * its "what does this tab render" questions to the unit and exclude the harness's own
 * force-rerender button — which is a control the tab did NOT render, and would otherwise
 * make that assertion permanently red.
 */
function Harness() {
  const [, force] = useState(0);
  return (
    <>
      <button type="button" data-testid="force-rerender" onClick={() => force((n) => n + 1)}>
        force
      </button>
      <div data-testid="tab-under-test">
        <UnifiedPendingTab
          openOnsiteReview={() => undefined}
          openOffsiteReview={() => undefined}
          openCombinedReview={() => undefined}
        />
      </div>
    </>
  );
}

const loadMore = () =>
  document.querySelector('[data-testid="apps-unified-review-load-more"]') as HTMLButtonElement;

/** Mantine renders a `loading` Button as `data-loading` + `disabled`. Read BOTH. */
function loadMoreIsSpinning() {
  const el = loadMore();
  if (!el) throw new Error('the Load-more control is not rendered — `hasMore` must be true');
  return { dataLoading: el.getAttribute('data-loading'), disabled: el.disabled };
}

async function settle() {
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
}

/** The options object each query was handed, or a loud failure if the mock is not wired. */
function opts() {
  if (!capturedOpts.onsite || !capturedOpts.offsite) {
    throw new Error('neither query captured its options — the trpc mock is not wired');
  }
  return { onsite: capturedOpts.onsite, offsite: capturedOpts.offsite };
}

/**
 * The captured query keys, with the same loud failure `opts()` has. Needed because the
 * cursor assertions read through `?.`, so an UNWIRED capture and a cursor that legitimately
 * did not move both present as `undefined` — the reassuring-zero shape.
 */
function inputs() {
  if (!capturedInput.onsite || !capturedInput.offsite) {
    throw new Error('neither query captured its input — the trpc mock is not wired');
  }
  return { onsite: capturedInput.onsite, offsite: capturedInput.offsite };
}

const forceRerender = () =>
  (document.querySelector('[data-testid="force-rerender"]') as HTMLButtonElement).click();

/**
 * The tab's own render anchor. It used to be the status row, which rendered
 * unconditionally; with that row deleted the list's count line is the thing that does —
 * it is `UnifiedReviewList`'s FIRST child and is emitted in every state (loading, empty,
 * errored, populated).
 */
const COUNT_TESTID = 'apps-unified-review-count';

beforeEach(() => {
  queryState.onsite.isFetching = false;
  queryState.onsite.error = null;
  queryState.onsite.data = { items: [], nextCursor: 'onsite-cursor-2' };
  queryState.offsite.isFetching = false;
  queryState.offsite.error = null;
  queryState.offsite.data = { items: [], nextCursor: null };
  capturedOpts.onsite = null;
  capturedOpts.offsite = null;
  capturedInput.onsite = null;
  capturedInput.offsite = null;
});

describe('🔴 the poll is WIRED — not merely decided correctly somewhere', () => {
  /**
   * 🔴 THE GAP THIS CLOSES, AND WHY IT IS THE MOST IMPORTANT SUITE IN THIS FILE. Every
   * other test here pins what the component does with a fetch that is already happening;
   * none of them can see whether the queue is WIRED to poll at all. Delete both
   * `refetchInterval` lines and both `refetchOnWindowFocus` lines from the page and every
   * one of those tests stays green — over a queue that never polls. The suite would assert
   * a falsehood, fully green.
   *
   * (There is no longer a companion unit suite. The poll was decided by an exported
   * `computeReviewQueuePollInterval` helper with `appsReviewQueuePoll.test.ts` pinning it;
   * deleting the cursor gate left the helper with zero inputs and nothing to decide, so
   * both went. The cadence is now the exported constant `APPS_REVIEW_POLL_MS`, read from
   * the real module below — so a renamed or deleted constant fails the import rather than
   * passing vacuously.)
   *
   * So these read the options object each query was actually handed.
   */
  test('both queries receive the cadence as their refetchInterval', async () => {
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId(COUNT_TESTID)).toBeInTheDocument();
    const { APPS_REVIEW_POLL_MS } = await import('~/pages/apps/review');

    for (const [label, o] of Object.entries(opts())) {
      expect(o.refetchInterval, label).toBe(APPS_REVIEW_POLL_MS);
    }
  });

  test('🔴 THE POLL KEEPS TICKING THROUGH AN ERROR — the queue self-heals', async () => {
    /**
     * 🔴 THE INVERSE OF A GUARD THIS FILE USED TO CARRY. An earlier revision parked the
     * interval on the query's own error, and the docblock justifying that park claimed it
     * was UNRECOVERABLE under the repo-wide `staleTime: Infinity`. ⚠️ That claim was FALSE
     * and is not the reason the gate is gone — a background error sets `isInvalidated` on
     * the existing data (query-core 5.101.0 `query.js:386-388`), `isStaleByTime` returns
     * `true` for an invalidated query (`query.js:134`), and `refetchOnReconnect` defaults
     * to `true`, so a reconnect recovers it; so does a remount, which `keepMounted={false}`
     * makes one click. `~/components/Apps/ActivePreviewsPanel` line 57 runs exactly that
     * gate today with no resume UI at all. The gate is gone because this tab's chosen
     * design is zero extra chrome, which an unconditional cadence needs least of.
     *
     * What this test pins is the consequence either way: a transient failure costs one
     * tick, because the interval still names the cadence and the next successful response
     * clears the error on its own. The mutant it kills is the restoration of that gate in
     * any shape — a `(query) => query.state.error ? false : MS` callback most obviously.
     * The error fixture is set on BOTH sources, because the gate it guards against was
     * per-query.
     */
    queryState.onsite.error = { message: 'INTERNAL_SERVER_ERROR' };
    queryState.offsite.error = { message: 'INTERNAL_SERVER_ERROR' };

    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId(COUNT_TESTID)).toBeInTheDocument();
    const { APPS_REVIEW_POLL_MS } = await import('~/pages/apps/review');

    for (const [label, o] of Object.entries(opts())) {
      expect(
        o.refetchInterval,
        `${label} parked on an error — the queue can never recover on its own`
      ).toBe(APPS_REVIEW_POLL_MS);
    }
  });

  test('🔴 OFF-SITE ALONE STILL PAGES, AND PAGING DOES NOT CHANGE THE CADENCE', async () => {
    /**
     * 🔴 THE ONE ARM WHERE THE OFF-SITE SOURCE IS THE *SOLE* ACTOR, AND THE REASON IT HAD
     * TO EXIST. Every other test in this file gives the on-site source the next page —
     * including the one that gives off-site a page too, which hands it one ALONGSIDE
     * on-site's, never INSTEAD. So every off-site disjunct in a paging-shaped `||` was
     * dead weight that no assertion could see. Mutants survived several review rounds in
     * that blind spot, and the two this fixture still kills are:
     *
     *   • deleting `onLoadMore`'s off-site branch — off-site paging silently never happens;
     *     Load more looks like it works because the on-site half grows.
     *   • `hasMore={onsiteNext != null}`           — an off-site-only remainder unmounts
     *     the control and the rest of the queue becomes unreachable.
     *
     * ⚠️ THE PARKING ASSERTION THIS TEST USED TO CARRY IS GONE, AND THE FIXTURE STAYED.
     * It asserted that paging either source stopped the poll. That gate has been deleted:
     * Pending is oldest-first and keyset-paginated on that order, so a NEW submission sorts
     * LAST and arrives in the window the last-loaded cursor covers — the very page a poll
     * refreshes. The assertion is inverted rather than dropped, because "the cadence is
     * unchanged while paged" is now the behaviour worth pinning, and it kills the
     * re-introduction of the gate in any shape.
     *
     * ⚠️ IT AWAITS THE COUNT LINE, NOT THE LOAD-MORE CONTROL, AND THAT IS DELIBERATE. The
     * count line renders unconditionally; the Load-more button does not. Awaiting the
     * button would make the `hasMore` mutant fail by matcher TIMEOUT rather than by a named
     * assertion, which is a much worse diagnosis. The synchronous `loadMore()` helper
     * throws with the sentence you actually want.
     */
    queryState.onsite.data = { items: [], nextCursor: null };
    queryState.offsite.data = { items: [], nextCursor: 'offsite-cursor-2' };

    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId(COUNT_TESTID)).toBeInTheDocument();
    const { APPS_REVIEW_POLL_MS } = await import('~/pages/apps/review');
    expect(opts().offsite.refetchInterval, 'the queue was not polling to begin with').toBe(
      APPS_REVIEW_POLL_MS
    );

    // An off-site-only remainder must still offer the control.
    expect(loadMore(), 'no Load more for an off-site-only remainder').toBeTruthy();

    queryState.offsite.isFetching = true;
    loadMore().click();
    await settle();

    // The off-site query key really moved to page 2 — direct evidence the branch ran,
    // rather than inferring it from a downstream effect.
    expect(inputs().offsite.cursor, 'the off-site cursor never advanced').toBe('offsite-cursor-2');
    expect(inputs().onsite.cursor, 'the on-site cursor moved without a next page').toBe(undefined);

    // …and paging changes NOTHING about the cadence, on either source.
    for (const [label, o] of Object.entries(opts())) {
      expect(
        o.refetchInterval,
        `${label} stopped polling once the queue was paged — the cursor gate is back`
      ).toBe(APPS_REVIEW_POLL_MS);
      expect(
        o.refetchOnWindowFocus,
        `${label} stopped refetching on focus once the queue was paged`
      ).toBe('always');
    }
  });

  test('🔴 placeholderData KEEPS THE PREVIOUS PAGE — or the Load-more button unmounts', async () => {
    // 🔴 THE GUARD FOR A STATE THIS SUITE'S FIXTURE CANNOT PRODUCE, WHICH IS WHY IT IS
    // ASSERTED ON THE OPTION RATHER THAN THE BEHAVIOUR.
    //
    // `cursor` is part of the query key, so "Load more" builds a key that has never been
    // fetched and `data` is `undefined` until the new page lands. `hasMore` is derived from
    // `data?.nextCursor` on both sources, and `UnifiedReviewList` renders the button under
    // `{hasMore && …}` — so without kept data the control is UNMOUNTED for exactly the
    // fetch its spinner is meant to describe, and the 'POSITIVE CONTROL' test below would
    // be certifying a state production cannot reach.
    //
    // The mock here returns the same object for every input, so it cannot reproduce that
    // `undefined` window; asserting the option is what closes the gap honestly instead of
    // pretending the fixture models react-query's data lifecycle. `keepPreviousData` is
    // identity on the previous value, which is the whole contract.
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('apps-unified-review-load-more')).toBeInTheDocument();

    const previous = { items: [], nextCursor: 'page-1-cursor' };
    for (const [label, o] of Object.entries(opts())) {
      expect(typeof o.placeholderData, `${label} got no placeholderData`).toBe('function');
      expect(
        (o.placeholderData as (prev: unknown) => unknown)(previous),
        `${label} did not keep the previous page`
      ).toBe(previous);
    }
  });

  test('🔴 refetchOnWindowFocus is `always`, NOT `true` — `true` would be silently inert', async () => {
    /**
     * 🔴 THE HALF OF THIS CLAIM THAT SURVIVED TWO STRIP-BACKS, AND IT IS THE LOAD-BEARING
     * HALF. This test used to also pin that the focus trigger ignores the error gate, and
     * then that it still honours the cursor gate; neither gate exists any more, so both
     * arms went with them. What remains is the option's VALUE, and it is worth more than
     * it looks.
     *
     * `src/utils/trpc.ts` sets `staleTime: Infinity` repo-wide. query-core 5.101.0 resolves
     * this option in `shouldFetchOn` (`queryObserver.js:450-453`) as
     *
     *     value === 'always' || (value !== false && isStale(query, options))
     *
     * and `isStale` is `query.isStaleByTime(Infinity)`, which is `false` for any query
     * holding data that has not been invalidated. So a plain `true` never reaches a fetch
     * after the first successful load — it is INERT in exactly the state it was added for,
     * and nothing about the spelling `refetchOnWindowFocus: true` says so. Only `'always'`
     * short-circuits ahead of that staleness check.
     *
     * That is why the failure message below names `true` explicitly: a reviewer "tidying"
     * the string down to a bare `true` is the realistic mutation, it looks strictly
     * simpler, and without this test the only symptom is a queue that quietly stops
     * refreshing on tab reveal.
     */
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('apps-unified-review-load-more')).toBeInTheDocument();

    for (const [label, o] of Object.entries(opts())) {
      expect(
        o.refetchOnWindowFocus,
        `${label}: refetchOnWindowFocus must be the string 'always', not true — under the ` +
          'repo-wide staleTime: Infinity, query-core gates `true` on isStale(), which is ' +
          'never true for a query holding data, so `true` is INERT after the first load'
      ).toBe('always');
    }
  });

  test('🔴 the Pending tab contributes NO controls of its own — zero extra chrome', async () => {
    /**
     * 🔴 THIS REPLACES EIGHT TESTS, AND IT PINS A DECISION RATHER THAN A MECHANISM. The
     * chosen refresh UX is "the table repaints itself" — no status line, no Refresh button,
     * no "N new" pill. A previous revision shipped a three-state status row and a Refresh
     * control; both existed only to explain and undo an error gate that has since been
     * deleted, and eight tests here pinned their wording. Deleting the gate made all of them
     * describe UI that should not exist, so they went and this took their place.
     *
     * 🔴 IT IS A RELATIONSHIP, NOT A SPELLING. Asserting `queryByText('Refresh')` is null
     * would be walked past by relabelling the button "Reload", and asserting on the old
     * `apps-review-refresh` testid by any new testid at all. What is asserted instead is
     * ownership: every control in this tab belongs to `UnifiedReviewList`, and nothing
     * renders above the list's own first element. A status line has no button and would slip
     * the first assertion; a Refresh control under any label or testid slips the second.
     * Together they say "the tab renders the list and nothing else" in a form a reword
     * cannot satisfy.
     */
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId(COUNT_TESTID)).toBeInTheDocument();

    const tab = document.querySelector('[data-testid="tab-under-test"]') as HTMLElement;

    // (1) Every button here is one the review LIST rendered. The harness's own
    // force-rerender button is outside `tab`, so it is not in scope.
    const strangers = [...tab.querySelectorAll('button')]
      .map((b) => b.getAttribute('data-testid') ?? '(no data-testid)')
      .filter((id) => !id.startsWith('apps-unified-review-'));
    expect(
      strangers,
      `the Pending tab rendered ${strangers.length} control(s) of its own (${strangers.join(
        ', '
      )}) — the chosen design is zero extra UI, so a Refresh-style button must not come back`
    ).toEqual([]);

    // (2) Nothing renders ABOVE the list. The count line is `UnifiedReviewList`'s FIRST
    // child, so walking from it up to the tab root, no level may have a preceding sibling —
    // any chrome the tab added before the list (a status row, a toolbar) would be exactly
    // that. Expressed as a walk rather than a child count so it does not also pin how many
    // wrapper elements Mantine's `<Stack>` happens to emit. This is what catches text-only
    // chrome, which assertion (1) cannot see.
    const count = tab.querySelector(`[data-testid="${COUNT_TESTID}"]`) as HTMLElement | null;
    expect(count, `the ${COUNT_TESTID} anchor is not rendered`).not.toBeNull();
    const preceding: string[] = [];
    for (let node = count as HTMLElement; node !== tab; node = node.parentElement as HTMLElement) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        preceding.push(`<${sibling.tagName.toLowerCase()}>${sibling.textContent ?? ''}`);
        sibling = sibling.previousElementSibling;
      }
    }
    expect(
      preceding,
      `${preceding.length} element(s) render above the review list (${preceding.join(' | ')}) ` +
        '— the Pending tab must render the list and nothing else'
    ).toEqual([]);
  });
});

describe('Load more vs the 15s background poll', () => {
  test('🔴 a BACKGROUND refetch leaves Load more idle and clickable', async () => {
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('apps-unified-review-load-more')).toBeInTheDocument();

    // Baseline: nothing fetching, nothing clicked.
    expect(loadMoreIsSpinning()).toEqual({ dataLoading: null, disabled: false });

    // The poll fires. This is the EXACT input the old `isFetching` wiring read.
    queryState.onsite.isFetching = true;
    queryState.offsite.isFetching = true;
    forceRerender();
    await settle();

    expect(
      loadMoreIsSpinning(),
      'a background poll put Load more into its loading state — this is the `isFetching` bug'
    ).toEqual({ dataLoading: null, disabled: false });
  });

  test('🔴 POSITIVE CONTROL — the SAME isFetching DOES spin once the mod clicks', async () => {
    // Without this, the test above is satisfied by a button that can never show progress.
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('apps-unified-review-load-more')).toBeInTheDocument();
    expect(loadMoreIsSpinning().disabled).toBe(false);

    // Click, then report the next page as in flight — which is what really happens: the
    // cursor is part of the query key, so the new key is fetching on the very next render.
    queryState.onsite.isFetching = true;
    loadMore().click();
    await settle();

    const spinning = loadMoreIsSpinning();
    expect(spinning.dataLoading, 'an explicit Load more must show progress').toBe('true');
    expect(spinning.disabled, 'and must not accept a second click while in flight').toBe(true);
  });

  test('the foreground state CLEARS when the page lands — it cannot stick', async () => {
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('apps-unified-review-load-more')).toBeInTheDocument();

    queryState.onsite.isFetching = true;
    loadMore().click();
    await settle();
    expect(loadMoreIsSpinning().disabled).toBe(true);

    // 🔴 THE ON-SITE PAGE LANDS FIRST AND THE OFF-SITE ONE IS STILL IN FLIGHT. Two separate
    // endpoints, so a completely ordinary interleaving — and the state that makes
    // `anyFetching` a two-source read rather than a one-source one. With
    // `anyFetching = onsiteQuery.isFetching` alone the flag clears here, and Load more goes
    // idle AND clickable while its own second page is still being fetched, which is exactly
    // what the positive control above says must not happen. That mutant passed the entire
    // suite before this arm existed, because no test ever made the off-site source the one
    // still fetching.
    queryState.onsite.isFetching = false;
    queryState.offsite.isFetching = true;
    forceRerender();
    await settle();
    expect(
      loadMoreIsSpinning(),
      'Load more went idle while the off-site page was still in flight'
    ).toEqual({ dataLoading: 'true', disabled: true });

    // Now BOTH have landed.
    queryState.offsite.isFetching = false;
    forceRerender();
    await settle();

    expect(loadMoreIsSpinning()).toEqual({ dataLoading: null, disabled: false });
  });
});

/**
 * Minimal structural rows. The adapters in `~/components/Apps/unifiedReviewRow` read only a
 * handful of fields; these mirror the factories in
 * `src/components/Apps/__tests__/unifiedReviewRow.test.ts`, which are file-local there.
 */
const onsiteRow = (id: string) => ({
  id,
  appBlockId: null,
  slug: `onsite-${id}`,
  version: '1.0.0',
  submittedAt: '2026-01-01T00:00:00Z',
  bundleSizeBytes: '10',
  bundleSha256: 'sha',
  manifest: {},
  fileSummary: {},
  manifestDiffSummary: {},
  reviewRepoUrl: 'https://forgejo.example/repo',
  submittedBy: { id: 7, username: 'onsite-dev', deletedAt: null, image: null },
});

const offsiteRow = (id: string) => ({
  id,
  appListingId: `apl-${id}`,
  slug: `offsite-${id}`,
  status: 'pending',
  submittedAt: '2026-01-02T00:00:00Z',
  changelog: null,
  appListing: {
    name: `External ${id}`,
    externalUrl: 'https://ex.com',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 9, username: 'offsite-dev', deletedAt: null, image: null },
});

const countText = () =>
  (document.querySelector('[data-testid="apps-unified-review-count"]') as HTMLElement).textContent;

describe('Load more APPENDS — the accumulators, which every other fixture here is blind to', () => {
  /**
   * 🔴 WHY THIS EXISTS AND WHY IT IS THE ONLY TEST IN THE FILE WITH ROWS. Every other
   * fixture carries `items: []`, so `onsiteItems` / `offsiteItems` are always empty, the
   * table never renders a row, and the count reads `0+ shown.` throughout. `onLoadMore` has
   * TWO statements per source —
   *
   *     setOnsiteAcc(onsiteItems);    // ← observable ONLY when rows exist
   *     setOnsiteCursor(onsiteNext);  // ← pinned by the capturedInput assertions
   *
   * — and the whole suite could see only the second. Deleting either accumulator write left
   * every other test in this file green, as did dropping `mergeById` from `onsiteItems`
   * entirely. In production that means page 2 REPLACES page 1: the moderator clicks Load
   * more and the first 50 rows vanish from the queue, while the cursor and `hasMore` both
   * stay correct — every signal the rest of this file reads is unchanged.
   *
   * BOTH sources page here, deliberately. An on-site-only fixture leaves the off-site
   * accumulator write just as invisible as it was before, which is the same
   * one-seam-at-a-time mistake this suite has already been caught making twice.
   */
  test('🔴 page 2 is APPENDED to page 1, on both sources', async () => {
    queryState.onsite.data = { items: [onsiteRow('on-1')], nextCursor: 'onsite-cursor-2' };
    queryState.offsite.data = { items: [offsiteRow('off-1')], nextCursor: 'offsite-cursor-2' };

    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId(COUNT_TESTID)).toBeInTheDocument();
    // One row per source, and `+` because both have a next page.
    expect(countText(), 'the fixture did not render its rows').toBe('2+ shown.');

    loadMore().click();
    await settle();

    // Page 2 lands on both — and BOTH still have a third page, which is what makes the
    // second turn below possible.
    queryState.onsite.data = { items: [onsiteRow('on-2')], nextCursor: 'onsite-cursor-3' };
    queryState.offsite.data = { items: [offsiteRow('off-2')], nextCursor: 'offsite-cursor-3' };
    forceRerender();
    await settle();

    expect(countText(), 'Load more REPLACED page 1 instead of appending to it').toBe('4+ shown.');

    /**
     * 🔴 A SECOND TURN, AND IT IS NOT REDUNDANT — ONE TURN CANNOT SEE THE ACCUMULATOR AT
     * ALL. On the FIRST Load more `onsiteCursor` is still `undefined`, so
     *
     *     onsiteItems = onsiteCursor ? mergeById(onsiteAcc, onsitePage) : onsitePage
     *
     * evaluates to `onsitePage` — the very same array reference. `setOnsiteAcc(onsiteItems)`
     * and `setOnsiteAcc(onsitePage)` therefore write identical state on turn 1, so
     * substituting one for the other is invisible to any fixture that clicks once. It is
     * also the substitution a tidier would actually make: `onsiteItems` reads circular
     * inside `onLoadMore`, and `onsitePage` looks like the obvious simplification.
     *
     * From the THIRD page on it drops every page but the last — the same vanishing-rows
     * defect this block is named for, one turn deeper, and with the cursor and `hasMore`
     * both still reading correctly.
     */
    expect(
      loadMoreIsSpinning().disabled,
      '`loadingMore` stuck — the second click would be swallowed, printing the same count a ' +
        'dropped-page bug does'
    ).toBe(false);

    loadMore().click();
    await settle();

    // Page 3 lands on both, and now neither has a next page.
    queryState.onsite.data = { items: [onsiteRow('on-3')], nextCursor: null };
    queryState.offsite.data = { items: [offsiteRow('off-3')], nextCursor: null };
    forceRerender();
    await settle();

    expect(countText(), 'page 1 was dropped — the accumulator holds only the last page').toBe(
      '6 shown.'
    );
  });
});
