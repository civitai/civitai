import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// The seam test below renders TWO trees in one test and has to tear the first one down —
// `component-setup`'s `afterEach` has not run yet, and two trees would make every
// `querySelector` read the first.
import { cleanup } from 'vitest-browser-react';
import { scopeGrantEmptyScopeLabel } from '~/shared/constants/app-surface-provenance';
// Type-only namespace import, NOT `typeof import('...')` — the latter is rejected by
// @typescript-eslint/consistent-type-imports. Used by the `importOriginal` spread below.
import type * as TrpcMod from '~/utils/trpc';

// Part B: the per-app "Permissions & activity" drawer. It reuses
// `BlockScopeList` for the granted scopes (filtered to THIS app's grant) and the
// shared `AppActivityPanel` for the interleaved Buzz + scope-invocation audit,
// scoped by appBlockId. Both feeds are viewer-scoped; an anonymous viewer gets a
// friendly empty state and the protected queries don't fire.
//
// Mock the tRPC client with configurable data + spy fns so we can assert the
// rendered rows, the empty states, and that the scope-invocation query is called
// with the current appBlockId. useCurrentUser is mocked to drive authed/anon.
const m = vi.hoisted(() => ({
  user: null as unknown,
  grants: [] as Array<{ appBlockId: string; slug: string; name: string; scopes: string[] }>,
  buzz: [] as unknown[],
  scopes: [] as unknown[],
  grantsSpy: undefined as unknown as ReturnType<typeof vi.fn>,
  buzzSpy: undefined as unknown as ReturnType<typeof vi.fn>,
  scopeSpy: undefined as unknown as ReturnType<typeof vi.fn>,
  // Store-visibility flags for `AppActivityPanel`'s `App` column. `null` (the default,
  // and what this file rendered under before) is what `useOptionalFeatureFlags` returns
  // outside a provider, which fails CLOSED — so a link test run at the default would be
  // vacuous. The seam test below sets a store-ELIGIBLE viewer deliberately.
  flags: null as null | Record<string, boolean>,
  // 🔴 DRIVES THE QUERY-ERROR ARM. Without it there was no way to render the state the
  // drawer's new error branch exists for, and that state is the one the component used to
  // get WRONG: `data` undefined + `isLoading` false is indistinguishable from "no grant
  // row", so a failed read rendered an affirmative sentence about what the viewer had
  // granted. A flag rather than a second spy so the success arms stay byte-identical.
  grantsError: false,
  /**
   * 🔴 THE SECOND ERROR SHAPE, WHICH `grantsError` ABOVE CANNOT EXPRESS. react-query sets
   * `isError` for a failed REFETCH too, and RETAINS `data` in that state — so an error arm placed
   * before the list arm discards a grant list the client still holds. Under `grantsError` the
   * broken and the fixed component render identically (`data` is undefined either way), which is
   * precisely why that flag is blind to this mutant.
   */
  grantsRefetchError: false,
}));

// 🔴 `AppActivityPanel`'s `When` column renders `DaysFromNow`, which reads
// `useIsClient()` from `IsClientProvider` and THROWS outside that provider
// ('missing IsClientContext'). `renderWithProviders` supplies Mantine + a QueryClient
// only, so the hook is stubbed here rather than the whole app shell being mounted.
// `true` is the post-mount value, which is the state every assertion below is about.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => m.user,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => m.flags ?? {},
  useOptionalFeatureFlags: () => m.flags,
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));

/**
 * 🔴 SPREADS THE REAL MODULE AND OVERRIDES ONLY WHAT IT USES. This was a WHOLESALE factory —
 * flagged by `local-rules/no-wholesale-module-mock`, which was pre-existing on this file (1 error
 * at `origin/main`, measured) and became this PR's problem the moment the PR edited the file, since
 * CI lints changed files. Fixed rather than suppressed: the rule names a real hazard, not a style
 * preference. A hand-written replacement module means the day `~/utils/trpc` gains an export this
 * factory omits, every importer in the graph gets `undefined`, the FILE fails to load, and the run
 * reports 0 tests collected with no failing assertion — silently green.
 *
 * Mechanical, and not invented here: the sibling `src/components/Apps/AppActivityPage.browser.test.tsx`
 * already spreads `importOriginal` over this exact module and passes in CI's component tier.
 * `setTrpcBatchingEnabled` keeps its explicit spy override — the spread would otherwise hand back
 * the real one.
 */
vi.mock('~/utils/trpc', async (importOriginal) => {
  // Three arms, mirroring react-query's three reachable states for this read. The REFETCH arm is
  // the one that carries `data` alongside `isError` — measured on 5.101 with this repo's defaults
  // as `status=error isError=true isRefetchError=true isLoadingError=false data=[…]`.
  const grantsSpy = vi.fn(() =>
    m.grantsRefetchError
      ? { data: m.grants, isLoading: false, isError: true, isRefetchError: true }
      : m.grantsError
      ? { data: undefined, isLoading: false, isError: true, isLoadingError: true }
      : { data: m.grants, isLoading: false, isError: false }
  );
  const buzzSpy = vi.fn(() => ({
    data: { pages: [{ items: m.buzz, nextCursor: null }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }));
  const scopeSpy = vi.fn(() => ({
    data: { pages: [{ items: m.scopes, nextCursor: null }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }));
  m.grantsSpy = grantsSpy;
  m.buzzSpy = buzzSpy;
  m.scopeSpy = scopeSpy;
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: {
      blocks: {
        listMyScopeGrants: { useQuery: grantsSpy },
        listMyAppActivity: { useInfiniteQuery: buzzSpy },
        listMyScopeInvocations: { useInfiniteQuery: scopeSpy },
      },
      // W13 — AppActivityPanel resolves rich-detail subject-ref ids via these batch lookups.
      // Stubbed rather than omitted: the fixtures DO carry rich rows (`detail.action`), they
      // just carry no `toUserId`/`entityType`, so the resolvers are handed empty id lists.
      modelVersion: { getVersionsByIds: { useQuery: () => ({ data: undefined }) } },
      useQueries: () => [],
    },
  };
});

// eslint-disable-next-line import/first
import { AppPermissionsActivityDrawer } from '~/components/AppBlocks/AppPermissionsActivityDrawer';
// eslint-disable-next-line import/first
import { AppActivityPanel } from '~/components/Apps/AppActivityPanel';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

/**
 * ONE row, read by BOTH mounts in the one-DOM seam test below. A row retyped per mount is how
 * two renderings come to disagree while each test stays green — the thing that test exists to
 * rule out, so its fixture cannot be duplicated either.
 */
const SEAM_ACTIVITY_ROW = {
  id: 'seam-1',
  // A fixed PAST instant, not a near-now one. `DaysFromNow` renders relatively and the seam test
  // compares the two mounts' cell text, so a date inside the live-update window could render
  // differently across the two renders. Months-ago is stable for the length of a run.
  createdAt: new Date('2026-07-14T10:00:00Z'),
  appBlockId: 'ab-1',
  appName: 'My App',
  appSlug: 'my-app',
  scope: 'ai:write:budgeted',
  endpoint: 'workflow:submit',
  statusCode: 200,
  detail: { action: 'workflow.submit', outcome: 'ok', workflowId: 'wf-seam' },
};

beforeEach(() => {
  m.user = { id: 1, username: 'viewer', isModerator: false };
  m.flags = null;
  m.grants = [];
  m.grantsError = false;
  m.grantsRefetchError = false;
  m.buzz = [];
  m.scopes = [];
  m.grantsSpy?.mockClear();
  m.buzzSpy?.mockClear();
  m.scopeSpy?.mockClear();
});

describe('AppPermissionsActivityDrawer (Part B — per-app permissions & activity)', () => {
  test('renders the granted-scopes list for THIS app + the activity timeline', async () => {
    // Two apps' grants — only the drawer's appBlockId ("ab-1") should render.
    m.grants = [
      { appBlockId: 'ab-1', slug: 'my-app', name: 'My App', scopes: ['user:read:self'] },
      { appBlockId: 'ab-2', slug: 'other', name: 'Other', scopes: ['buzz:read:self'] },
    ];
    m.scopes = [
      {
        id: '1',
        createdAt: new Date('2026-07-14T10:00:00Z'),
        appBlockId: 'ab-1',
        appName: 'My App',
        appSlug: 'my-app',
        // Distinct from the granted scope above so the "user:read:self" grant
        // badge is the sole node carrying that string (the Detail column would
        // otherwise echo a matching endpoint verbatim).
        scope: 'ai:write:budgeted',
        // Bounded endpoint template; the workflow id is per-row `detail`.
        endpoint: 'workflow:submit',
        statusCode: 200,
        detail: { action: 'workflow.submit', outcome: 'ok', workflowId: 'wf-123' },
      },
    ];
    m.buzz = [
      {
        id: 'b1',
        createdAt: new Date('2026-07-14T09:00:00Z'),
        appBlockId: 'ab-1',
        appName: 'My App',
        appSlug: 'my-app',
        scope: 'per_model_install',
        usdAmountCents: 150,
        status: 'confirmed',
      },
    ];

    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );

    // Granted scope for ab-1 shows (via BlockScopeList); ab-2's scope must NOT leak.
    await expect.element(page.getByText('user:read:self')).toBeInTheDocument();
    expect(page.getByText('buzz:read:self').elements()).toHaveLength(0);

    // Activity timeline: the scope-invocation row (workflow submit) humanises to
    // "Generated an image" and the Buzz row to "Spent Buzz on a per-model install".
    await expect.element(page.getByText('Generated an image')).toBeInTheDocument();
    await expect.element(page.getByText('Spent Buzz on a per-model install')).toBeInTheDocument();
  });

  test('BOTH activity queries (Buzz + scope-invocations) are server-filtered by the current appBlockId', async () => {
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-42" appName="Scoped" opened onClose={() => {}} />
    );
    await expect.element(page.getByTestId('app-permissions-activity-drawer')).toBeInTheDocument();
    // Scope-invocation audit — server-filtered.
    expect(m.scopeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ appBlockId: 'ab-42' }),
      expect.anything()
    );
    // Buzz attribution — now ALSO server-filtered (the fix): the per-app Buzz
    // timeline paginates the single app's feed, not the whole account.
    expect(m.buzzSpy).toHaveBeenCalledWith(
      expect.objectContaining({ appBlockId: 'ab-42' }),
      expect.anything()
    );
  });

  test('whole-account panel (installed page, no appBlockId) does NOT pass an appBlockId filter — unchanged behaviour', async () => {
    // The shared AppActivityPanel rendered without an appBlockId (the
    // /apps/activity "Recent activity" tab) must keep fetching the whole-account
    // feed — neither query carries an appBlockId.
    renderWithProviders(<AppActivityPanel />);
    // Await the rendered empty state so the query hooks have run before asserting.
    await expect.element(page.getByText(/No activity yet\./)).toBeInTheDocument();
    expect(m.buzzSpy).toHaveBeenCalled();
    expect(m.scopeSpy).toHaveBeenCalled();
    expect(m.buzzSpy.mock.calls[0][0]).not.toHaveProperty('appBlockId');
    expect(m.scopeSpy.mock.calls[0][0]).not.toHaveProperty('appBlockId');
  });

  test('empty state when the viewer has no grants and no activity for this app', async () => {
    m.grants = [];
    m.buzz = [];
    m.scopes = [];
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );
    // 🔴 STILL THE WHOLE NORMALISED STRING, BUT NOW *DERIVED* FROM THE SHARED OWNER RATHER
    // THAN COPIED. The label used to be a literal in the component and a second literal here;
    // it now comes from `scopeGrantEmptyScopeLabel`, which both this drawer and
    // `src/pages/apps/activity.tsx` call. A "these two agree" guard written as a hand-copied
    // literal on each side pins NOTHING — change the component and its own copy of the literal
    // and both stay green while the page silently diverges. Calling the exported function is
    // what makes this a consolidation pin instead of a transcription.
    //
    // Still NOT a keyword match: the claim under test is that the label does not assert "you
    // granted this app nothing", and a `/permissions/` substring would walk straight past the
    // false wording, which contained that word too.
    //
    // `'activity'` is the origin the component passes when there is NO grant row at all
    // (`grant?.origin ?? 'activity'`) — the state this test sets up with `m.grants = []`. The
    // two load-bearing halves survive the move: it says nothing was granted, and it points at
    // Recent activity.
    const expectedEmptyLabel = scopeGrantEmptyScopeLabel('activity');
    // Guard the guard: an owner that returned '' would make the locator match anything.
    expect(expectedEmptyLabel.length).toBeGreaterThan(40);
    await expect.element(page.getByText(expectedEmptyLabel)).toBeInTheDocument();
    await expect.element(page.getByText(/No activity yet\./)).toBeInTheDocument();
  });

  /**
   * 🔴 A FAILED READ MUST NOT RENDER A CLAIM ABOUT THE VIEWER'S HISTORY. The defect: on a query
   * error `data` is `undefined` and `isLoading` is `false`, which is byte-for-byte the state the
   * test ABOVE sets up — so with no error branch the drawer fell through to
   * `scopeGrantEmptyScopeLabel('activity')` and told the viewer what they had and had not granted,
   * from a read it never received. (The hard-coded string this label replaced was record-shaped,
   * "No permissions recorded …", so it survived the same state; the origin-derived label is a
   * strictly stronger factual claim and needs the branch the old one did not.)
   *
   * 🔴 THE SECOND HALF IS THE ONE THAT CATCHES THE REGRESSION. Asserting the error text appears
   * does not prove the denial is gone — a component rendering BOTH would pass. The
   * `not.toBeInTheDocument` on the derived label is what pins it, and it is derived from the owner
   * for the same reason the test above is.
   */
  test('🔴 a query ERROR shows a read failure, not a statement about what was granted', async () => {
    m.grantsError = true;
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );
    await expect
      // `&apos;` in the JSX is U+0027, not a typographic apostrophe — the class of mismatch that
      // makes a text locator silently match nothing, so the character is spelled, not guessed.
      .element(page.getByText(/couldn't load this app's permissions just now/))
      .toBeInTheDocument();
    const deniedLabel = scopeGrantEmptyScopeLabel('activity');
    expect(deniedLabel.length).toBeGreaterThan(40);
    await expect.element(page.getByText(deniedLabel)).not.toBeInTheDocument();
  });

  /**
   * 🔴 THE OTHER HALF OF THE SAME CONTRACT, AND THE TEST ABOVE IS STRUCTURALLY BLIND TO IT.
   * `isError` is ALSO true for a failed REFETCH, and in that state react-query RETAINS `data` —
   * measured on this repo's `@tanstack/react-query` 5.101 with its own defaults as
   * `status=error isError=true isRefetchError=true isLoadingError=false data=[…]`. Because the
   * error arm sits BEFORE the list arm, a bare `isError` replaced a complete valid grant list with
   * read-failure copy. The test above cannot see this — under a first-fetch failure `data` is
   * undefined, so the broken and the fixed component render identically.
   *
   * ⚠️ REACHABLE INDIRECTLY, NOT "ON THE ACTIVITY PAGE'S TOGGLE" — an earlier revision of this
   * docblock named a trigger that cannot fire here. Complete enumeration: the only two
   * `listMyScopeGrants.invalidate()` sites are `src/pages/apps/activity.tsx` `:111` and `:414`, and
   * this drawer is mounted from exactly ONE place, `src/components/AppBlocks/IframeHost.tsx` — never
   * from that page; with `staleTime: Infinity` and `refetchOnWindowFocus: false` it has no automatic
   * refetch either. The real path: an activity-page invalidate whose refetch fails (the batch cohort
   * retries ZERO times — `queryRetry` in `src/utils/trpc.ts`) leaves the query error-and-stale in
   * the shared cache, and a LATER drawer mount observes that state.
   */
  test('🔴 a failed REFETCH keeps the grants it already has — `isError` alone would discard them', async () => {
    m.grants = [
      { appBlockId: 'ab-1', slug: 'my-app', name: 'My App', scopes: ['user:read:self'] },
      { appBlockId: 'ab-2', slug: 'other', name: 'Other', scopes: ['buzz:read:self'] },
    ];
    m.grantsRefetchError = true;
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );
    // The retained grant for THIS app still renders, and the other app's still does not leak.
    await expect.element(page.getByText('user:read:self')).toBeInTheDocument();
    expect(page.getByText('buzz:read:self').elements()).toHaveLength(0);
    // 🔴 WHICH ASSERTION KILLS THE MUTANT — MEASURED, NOT ASSUMED. Reverting the guard to bare
    // `isError` fails this test on the GRANT-BADGE WAIT above, with
    // `VitestBrowserElementError: Cannot find element with locator: getByText('user:read:self')`
    // — i.e. on the claim that the retained grant is rendered, which is the guard's own reason. The
    // `not.toContain` below never executes on that mutant and is NOT what catches it; it is the
    // second pin, for a component that renders BOTH the list and the read-failure sentence, which
    // the badge assertion alone would pass.
    expect(document.body.textContent ?? '').not.toContain(
      "couldn't load this app's permissions just now"
    );
  });

  /**
   * 🔴 THE CELL BOTH ARMS ABOVE MISS, AND THE REASON THE GUARD TESTS `grant` RATHER THAN `data`.
   * This component consumes exactly one thing — `grantsQuery.data?.find(g => g.appBlockId ===
   * appBlockId)` — so "the client holds SOME data" is the wrong question. With `data` retained from
   * a prior success that did NOT contain this app, plus a failed refetch, `!grantsQuery.data` was
   * false and control fell through to `scopeGrantEmptyScopeLabel(grant?.origin ?? 'activity')`: a
   * DENIAL about this app ("You have not installed this app, and no separate permission grant is on
   * record for it") drawn from a read that failed. That is verbatim the defect the first arm above
   * exists to prevent, surviving in a state that arm cannot produce.
   *
   * Reachable by the same indirect path as the arm above: the drawer is mounted only from
   * `IframeHost.tsx`, so it observes an activity-page invalidate whose refetch failed — and the
   * activity page's own list need not mention the app whose run-frame this drawer sits on.
   *
   * MUTATION-VERIFIED: reverting the guard to `isError && !grantsQuery.data` fails this test on the
   * read-failure WAIT below — `VitestBrowserElementError: Cannot find element with locator:
   * getByText(/couldn't load this app's permissions just now/)` — i.e. on this guard's own sentence.
   * The `not.toBeInTheDocument` on the derived label is the second pin, for a component rendering
   * BOTH.
   */
  test('🔴 a failed refetch whose retained list LACKS this app shows the read failure, not a denial', async () => {
    m.grants = [{ appBlockId: 'ab-2', slug: 'other', name: 'Other', scopes: ['buzz:read:self'] }];
    m.grantsRefetchError = true;
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );
    await expect
      .element(page.getByText(/couldn't load this app's permissions just now/))
      .toBeInTheDocument();
    // 🔴 THE DENIAL MUST BE ABSENT, and it is derived from its owner rather than retyped — a copy
    // of the sentence here would keep passing after the owner's wording changed.
    const deniedLabel = scopeGrantEmptyScopeLabel('activity');
    expect(deniedLabel.length).toBeGreaterThan(40);
    await expect.element(page.getByText(deniedLabel)).not.toBeInTheDocument();
    // …and the OTHER app's retained scope must not leak into this drawer either.
    expect(page.getByText('buzz:read:self').elements()).toHaveLength(0);
  });

  test('anonymous viewer gets a sign-in empty state and the activity queries do not fire', async () => {
    m.user = null;
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );
    await expect
      .element(page.getByText("Sign in to see the permissions you've granted this app."))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Sign in to see this app's recent activity on your account."))
      .toBeInTheDocument();
    // The AppActivityPanel isn't mounted for anon, so the scope-invocation query
    // is never called.
    expect(m.scopeSpy).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE SEAM. `AppActivityPanel`'s `App` column gained a link to
   * `/apps/store-preview/<slug>`; this drawer is the OTHER mount point, and it sits on top
   * of a RUNNING full-page app. A top-level `<a>` here navigates the whole window out of
   * the app the user is in — from a panel they opened to read — and the column is
   * redundant in this mode anyway, since every row is the same app.
   *
   * Verified in ISOLATION the panel is correct either way; the defect this pins lives in
   * the seam, i.e. in whether the drawer's caller actually reaches the suppressing branch.
   * So the flags are set to a STORE-ELIGIBLE viewer and the row carries a REAL slug —
   * neither the flag gate nor a null slug can be why it passes.
   *
   * 🔴 RED WITHOUT THE CHANGE: drop `linkable={!appBlockId}` from the panel's
   * `ActivityAppName` call (or default the prop to `true` unconditionally) and this fails
   * on `expected 'A' not to be 'A'`, while the whole-account control below stays green.
   */
  test('🔴 the App name is PLAIN TEXT in the drawer, even for a store-eligible viewer', async () => {
    m.flags = { appListings: true };
    m.scopes = [
      {
        id: '1',
        createdAt: new Date('2026-07-14T10:00:00Z'),
        appBlockId: 'ab-1',
        appName: 'My App',
        appSlug: 'my-app',
        scope: 'buzz:read:self',
        endpoint: 'me',
        statusCode: 200,
        detail: null,
      },
    ];
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={vi.fn()} />
    );
    const name = page.getByTestId('app-activity-app-name');
    await expect.element(name.first()).toBeInTheDocument();
    const el = name.first().element();
    expect(
      el.tagName,
      'the drawer must not offer a link that navigates out of the running app'
    ).not.toBe('A');
    expect(el.getAttribute('href')).toBeNull();
  });

  test('POSITIVE CONTROL: the same viewer + row DOES get a link on the whole-account feed', async () => {
    // Identical flags, identical row, no `appBlockId`. Without this the test above would
    // be satisfied by a panel that never links at all.
    m.flags = { appListings: true };
    m.scopes = [
      {
        id: '1',
        createdAt: new Date('2026-07-14T10:00:00Z'),
        appBlockId: 'ab-1',
        appName: 'My App',
        appSlug: 'my-app',
        scope: 'buzz:read:self',
        endpoint: 'me',
        statusCode: 200,
        detail: null,
      },
    ];
    renderWithProviders(<AppActivityPanel />);
    const name = page.getByTestId('app-activity-app-name');
    await expect.element(name.first()).toBeInTheDocument();
    expect(name.first().element().tagName).toBe('A');
    expect(name.first().element().getAttribute('href')).toBe('/apps/store-preview/my-app');
  });

  /**
   * 🔴 ONE DOM, RESTRUCTURED BY CSS — the contract the narrow (card) rendering rests on.
   *
   * The drawer gives `AppActivityPanel` ~408px against a table whose max-content sum is
   * ~735px, so below ~560px of CONTAINER it renders each row as a card. That swap is done
   * entirely in `AppActivityPanel.module.scss`; there is no second JSX branch, and this test is
   * what pins that. A two-variant render would duplicate every `data-testid` (breaking the
   * `getByTestId` specs above) and give the drawer and the page two cell sets that can drift —
   * the hazard this file's `App`-column seam test already records in its own terms.
   *
   * ⚠️ THE PIXELS ARE NOT HERE. This tier injects `globals.css`'s `:root` block only, so no
   * `@container` rule in the module is even present — the measured swap lives in
   * `src/components/Apps/AppsWideLayout.geometry.test.tsx` ("the drawer's activity feed
   * renders the STACKED variant, and the wide page does not"). What this arm owns is the
   * property that makes that swap POSSIBLE: both mounts produce the same cells, in the same
   * order, from one fixture.
   */
  test('🔴 the drawer and the whole-account feed render ONE activity DOM from one fixture', async () => {
    m.flags = { appListings: true };
    m.scopes = [SEAM_ACTIVITY_ROW];

    const readCells = () => {
      const panels = document.querySelectorAll('[data-testid="app-activity-panel"]');
      // A two-variant render shows up here first: two panels, or two tables inside one.
      expect(panels).toHaveLength(1);
      expect(panels[0].querySelectorAll('table')).toHaveLength(1);
      return Array.from(panels[0].querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td): [string, string, string] => [
          // A cell with no attribute reads as a sentinel rather than as `undefined`, so the
          // ledger below names the missing hook instead of printing a blank.
          td.dataset.activityCell ?? '(no data-activity-cell)',
          (td.textContent ?? '').trim(),
          // 🔴 `role` IS IN THE LEDGER, NOT ONLY IN THE STANDALONE READ BELOW. That read runs
          // against the PAGE mount only (the drawer tree is torn down first), so a change that
          // emitted the roles on one mount and not the other — `role={linkable ? 'cell' :
          // undefined}` is the plausible shape, since `linkable` is exactly what differs — would
          // turn nothing red in the one test whose purpose is that the two mounts agree.
          td.getAttribute('role') ?? '(no role)',
        ])
      );
    };

    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={vi.fn()} />
    );
    await expect.element(page.getByTestId('app-activity-panel')).toBeInTheDocument();
    const inDrawer = readCells();
    await cleanup();

    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByTestId('app-activity-panel')).toBeInTheDocument();
    const onPage = readCells();

    // Every cell is addressable by NAME, which is what the module CSS reorders by — an
    // `nth-child` rule would silently re-point if a column were ever inserted, and the
    // attribute is what makes the reorder legible at the call site.
    expect(inDrawer.map((row) => row.map(([name]) => name))).toEqual([
      ['when', 'app', 'action', 'detail', 'status'],
    ]);
    // `when` is excluded from the text ledger on purpose: `DaysFromNow` renders RELATIVE to
    // now, so pinning its string would rot as the fixture date ages.
    const withoutWhen = (rows: [string, string, string][][]) =>
      rows.map((row) => row.filter(([name]) => name !== 'when'));
    expect(withoutWhen(inDrawer)).toEqual([
      [
        ['app', 'My Appmy-app', 'cell'],
        ['action', 'Generated an image', 'cell'],
        // The visually-hidden prefix is part of the cell's TEXT, which is the point — an
        // `aria-label` on Mantine's Badge would land on a `role="generic"` div and name nothing.
        ['detail', 'workflow wf-seam', 'cell'],
        ['status', 'HTTP status 200', 'cell'],
      ],
    ]);
    // …and the `when` cell is still the `<time>` element, which is the half a text ledger
    // cannot assert.
    expect(
      document.querySelector('[data-activity-cell="when"] time')?.getAttribute('datetime')
    ).toBeTruthy();

    // 🔴 THE TABLE ROLES ARE EXPLICIT, AND THAT IS WHAT SURVIVES THE CARD VARIANT. `display:
    // block` on a `<table>`/`<tr>`/`<td>` drops its implicit role in every engine, so below the
    // breakpoint the audit feed would reach assistive tech as a flat run of strings. A DOM
    // assertion rather than a computed-style one, because this tier loads no cascade.
    const panelEl = document.querySelector('[data-testid="app-activity-panel"]')!;
    expect(panelEl.querySelector('table')?.getAttribute('role')).toBe('table');
    // `tbody` too: the module sets `display: block` on it, which strips its implicit `rowgroup`
    // and with it the rows' group boundary. It is the one header-side role that is load-bearing,
    // and it was unasserted while a comment said this ledger covered the roles.
    expect(panelEl.querySelector('tbody')?.getAttribute('role')).toBe('rowgroup');
    expect(
      Array.from(panelEl.querySelectorAll('tbody tr')).map((tr) => tr.getAttribute('role'))
    ).toEqual(['row']);
    expect(
      Array.from(panelEl.querySelectorAll('tbody td')).map((td) => td.getAttribute('role'))
    ).toEqual(['cell', 'cell', 'cell', 'cell', 'cell']);
    // …and the one cell value that is meaningless without the header the card variant hides is
    // named by visually-hidden TEXT, which is real content an accessibility tree can use.
    const srOnly = panelEl.querySelector('[data-activity-cell="status"] .sr-only');
    expect(srOnly?.textContent).toBe('HTTP status ');
    // The `App` cell is the one documented difference between the two mounts (plain text in
    // the drawer, a link on the page) and its TEXT is identical, so comparing the two ledgers
    // is a claim about structure rather than about that decision.
    expect(onPage).toEqual(inDrawer);
  });

  test('a closed drawer does not mount the body (no queries fire)', async () => {
    renderWithProviders(
      <AppPermissionsActivityDrawer
        appBlockId="ab-1"
        appName="My App"
        opened={false}
        onClose={() => {}}
      />
    );
    expect(m.grantsSpy).not.toHaveBeenCalled();
    expect(m.scopeSpy).not.toHaveBeenCalled();
  });
});
