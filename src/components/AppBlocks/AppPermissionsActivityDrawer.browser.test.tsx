import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';

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

vi.mock('~/utils/trpc', () => {
  const grantsSpy = vi.fn(() => ({ data: m.grants, isLoading: false }));
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
    setTrpcBatchingEnabled: vi.fn(),
    trpc: {
      blocks: {
        listMyScopeGrants: { useQuery: grantsSpy },
        listMyAppActivity: { useInfiniteQuery: buzzSpy },
        listMyScopeInvocations: { useInfiniteQuery: scopeSpy },
      },
      // W13 — AppActivityPanel resolves rich-detail subject-ref ids via these
      // batch lookups. Stub them (no rich rows in these fixtures → inert).
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

beforeEach(() => {
  m.user = { id: 1, username: 'viewer', isModerator: false };
  m.flags = null;
  m.grants = [];
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
    // 🔴 PINNED AS THE WHOLE NORMALISED STRING, NOT A KEYWORD. The claim under test is
    // that this label does NOT assert "you granted this app nothing" — a defect a
    // `/permissions/` substring match would walk straight past, since the false wording
    // contained that word too. The two load-bearing halves are the qualifier
    // ("from an install") and the pointer to Recent activity.
    await expect
      .element(
        page.getByText(
          'No permissions recorded from an install of this app — which is not the same as no access. Anything it has actually done on your account is listed under Recent activity below.'
        )
      )
      .toBeInTheDocument();
    await expect.element(page.getByText(/No activity yet\./)).toBeInTheDocument();
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
