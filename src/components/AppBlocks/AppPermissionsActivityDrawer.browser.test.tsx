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
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => m.user,
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
    },
  };
});

// eslint-disable-next-line import/first
import { AppPermissionsActivityDrawer } from '~/components/AppBlocks/AppPermissionsActivityDrawer';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

beforeEach(() => {
  m.user = { id: 1, username: 'viewer', isModerator: false };
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
        endpoint: 'workflow:submit:wf-123',
        statusCode: 200,
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
      <AppPermissionsActivityDrawer
        appBlockId="ab-1"
        appName="My App"
        opened
        onClose={() => {}}
      />
    );

    // Granted scope for ab-1 shows (via BlockScopeList); ab-2's scope must NOT leak.
    await expect.element(page.getByText('user:read:self')).toBeInTheDocument();
    expect(page.getByText('buzz:read:self').elements()).toHaveLength(0);

    // Activity timeline: the scope-invocation row (workflow submit) humanises to
    // "Generated an image" and the Buzz row to "Spent Buzz on a per-model install".
    await expect.element(page.getByText('Generated an image')).toBeInTheDocument();
    await expect
      .element(page.getByText('Spent Buzz on a per-model install'))
      .toBeInTheDocument();
  });

  test('the scope-invocation query is called with the current appBlockId', async () => {
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-42" appName="Scoped" opened onClose={() => {}} />
    );
    await expect
      .element(page.getByTestId('app-permissions-activity-drawer'))
      .toBeInTheDocument();
    expect(m.scopeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ appBlockId: 'ab-42' }),
      expect.anything()
    );
  });

  test('empty state when the viewer has no grants and no activity for this app', async () => {
    m.grants = [];
    m.buzz = [];
    m.scopes = [];
    renderWithProviders(
      <AppPermissionsActivityDrawer appBlockId="ab-1" appName="My App" opened onClose={() => {}} />
    );
    await expect
      .element(page.getByText("You haven't granted this app any permissions yet."))
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
