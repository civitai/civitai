import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

// No explicit `test/component-setup` import (it still runs as the project's setup file): importing
// it here re-registers its `next/router` stub over the one below, and the route query is lost.

/**
 * `/user/[username]` under `ssrSignedInSkipPrefetchUser`'s `skip` arm (`deferredSsr`), across a
 * real `renderToString` → `hydrateRoot` of the real `ProfileLayout2` (as `UserProfileLayout` hands
 * it the page). Its data hooks are fixed, its sidebar, header and navigation are probes, `Meta`
 * records what the page hands its `<head>`, and `AppLayout` is reduced to its loading / NotFound /
 * slots decision.
 *
 * - The server HTML keeps the navigation and puts a loader in place of the sidebar, header and
 *   sections, with the same `<head>` as the full page; the hydrating render reproduces it, and the
 *   rest renders once the client has mounted.
 * - A missing profile is NotFound and a profile whose owner blocked the viewer is the blocked panel,
 *   on the server, never the shell: the `skip` arm keeps `userProfile.get` for exactly that
 *   (`src/tests/pages/user/user-page-skip-prefetch.test.ts`).
 */

const user = {
  id: 7,
  username: 'maker',
  profilePicture: null,
  bannedAt: null as Date | null,
  deletedAt: null,
  rank: null,
  stats: { followerCountAllTime: 20, thumbsUpCountAllTime: 3, downloadCountAllTime: 4 },
};

const m = vi.hoisted(() => ({
  user: null as unknown,
  shareable: undefined as boolean | undefined,
  // ONE router object, as Next's is.
  router: { query: {} as Record<string, string> },
  meta: [] as Record<string, unknown>[],
}));

vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => m.router,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePathname: () => '/user/maker',
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../test/trpcProxyStub')).makeTrpcProxy({
    'userProfile.get': { useQuery: () => ({ isInitialLoading: false, data: m.user }) },
    'userProfile.overview': { useQuery: () => ({ data: { modelCount: 2 } }) },
    'creatorJourney.isMilestoneShareable': { useQuery: () => ({ data: m.shareable }) },
  }),
}));
vi.mock('~/components/Meta/Meta', () => ({
  Meta: (props: Record<string, unknown>) => {
    m.meta.push(props);
    return null;
  },
}));
vi.mock('~/components/AppLayout/AppLayout', () => ({
  AppLayout: ({
    loading,
    notFound,
    left,
    subNav,
    children,
  }: {
    loading?: boolean;
    notFound?: boolean;
    left?: ReactNode;
    subNav?: ReactNode;
    children: ReactNode;
  }) =>
    loading ? (
      <div data-testid="layout-loading" />
    ) : notFound ? (
      <div data-testid="not-found" />
    ) : (
      <div>
        {subNav}
        {left}
        {children}
      </div>
    ),
}));
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
vi.mock('~/hooks/hidden-preferences', async (o) => ({
  ...(await o<object>()),
  useHiddenPreferencesData: () => ({ blockedUsers: [] }),
}));
vi.mock('~/components/PageLoader/PageLoader', () => ({
  PageLoader: () => <div data-testid="page-loader" />,
}));
vi.mock('~/components/Profile/ProfileSidebar', () => ({
  ProfileSidebar: () => <div data-testid="profile-sidebar" />,
}));
vi.mock('~/components/Profile/ProfileHeader', () => ({
  ProfileHeader: () => <div data-testid="profile-header" />,
}));
vi.mock('~/components/Profile/ProfileNavigation', () => ({
  ProfileNavigation: () => <div data-testid="profile-navigation" />,
}));
const stub = vi.hoisted(() => () => null);
vi.mock('~/components/UserAvatar/UserAvatar', async (o) => ({
  ...(await o<object>()),
  UserAvatar: stub,
}));
vi.mock('~/components/HideUserButton/BlockUserButton', async (o) => ({
  ...(await o<object>()),
  BlockUserButton: stub,
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', async (o) => ({
  ...(await o<object>()),
  LoginRedirect: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { UserProfileLayout } = await import('~/components/Profile/ProfileLayout2');

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  m.user = user;
  m.shareable = undefined;
  m.router.query = { username: 'maker' };
  m.meta = [];
  consoleErrors = [];
  recoverable = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsole?.();
  for (const r of roots.splice(0)) r.unmount();
  for (const c of containers.splice(0)) c.remove();
});

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const hydrationErrors = () => [
  ...recoverable,
  ...consoleErrors.filter((e) => HYDRATION_RE.test(e)),
];

/** The overview page's own content, as a probe. */
function ProfileOverview(_: { deferredSsr?: boolean }) {
  return <div data-testid="profile-sections" />;
}

function Tree({ client, deferredSsr }: { client: QueryClient; deferredSsr: boolean }) {
  // As `_app` does: the layout gets the page element with the page's props.
  return (
    <QueryClientProvider client={client}>
      <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
        {UserProfileLayout(<ProfileOverview {...(deferredSsr ? { deferredSsr } : {})} />)}
      </MantineProvider>
    </QueryClientProvider>
  );
}

/** The server render alone: its HTML and the last `Meta` props it rendered. */
function serverRender(deferredSsr: boolean) {
  m.meta = [];
  const html = renderToString(<Tree client={new QueryClient()} deferredSsr={deferredSsr} />);
  return { html, meta: m.meta.at(-1) };
}

async function serverThenHydrate(server: boolean, client = server) {
  const { html } = serverRender(server);
  // The "server" render runs in the browser, so React warns about `useLayoutEffect` in
  // `renderToString`; only the hydration is measured.
  consoleErrors = [];
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  roots.push(
    hydrateRoot(container, <Tree client={new QueryClient()} deferredSsr={client} />, {
      onRecoverableError: (err) =>
        recoverable.push(err instanceof Error ? err.message : String(err)),
    })
  );
  await flush();
  return { html, container };
}

const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;
const CONTENT = ['profile-sidebar', 'profile-header', 'profile-sections'];

describe('profile — deferredSsr (ssrSignedInSkipPrefetchUser skip arm)', () => {
  test('INSTRUMENT CHECK: hydrating the shell with the full page IS reported as a mismatch', async () => {
    await serverThenHydrate(true, false);
    expect(hydrationErrors().length).toBeGreaterThan(0);
  });

  test('deferredSsr false (flag off, anonymous, bots, every other profile tab): as before', async () => {
    const { html } = await serverThenHydrate(false);
    // Positive control: the probes do reach the server HTML.
    expect(CONTENT.filter((id) => !has(html, id))).toEqual([]);
    expect(has(html, 'page-loader')).toBe(false);
    expect(hydrationErrors()).toEqual([]);
  });

  test('server HTML is the navigation and one loader; it hydrates with no mismatch, then the rest renders', async () => {
    const { html, container } = await serverThenHydrate(true);

    expect(count(html, 'page-loader')).toBe(1);
    expect(has(html, 'profile-navigation')).toBe(true);
    expect(CONTENT.filter((id) => has(html, id))).toEqual([]);
    expect(hydrationErrors()).toEqual([]);
    // Mounted: the rest, the loader gone.
    for (const id of CONTENT)
      expect(container.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    expect(container.querySelector('[data-testid="page-loader"]')).toBeNull();
  });

  test('the shell fills <head> exactly as the full page does', () => {
    const full = serverRender(false).meta;
    const shell = serverRender(true).meta;

    expect(shell).toMatchObject({ canonical: '/user/maker', deIndex: false });
    expect(shell?.title).toEqual(expect.stringContaining('maker'));
    expect(shell).toEqual(full);
  });

  test("a shared milestone link: the shell's og:image is the card, as the full page's is", () => {
    m.router.query = { username: 'maker', milestone: 'supernova' };
    m.shareable = true;
    const full = serverRender(false).meta;
    const shell = serverRender(true).meta;

    expect(shell?.ogEndpoint).toBe('/api/og?type=milestone&id=7.supernova');
    expect(shell).toEqual(full);
  });

  test('a banned account: the shell is noindex, as the full page is', () => {
    m.user = { ...user, bannedAt: new Date('2026-10-01') };
    const full = serverRender(false).meta;
    const shell = serverRender(true).meta;

    expect(shell?.deIndex).toBe(true);
    expect(shell).toEqual(full);
  });

  test('a profile the viewer gets none of: NotFound on the server, not the shell', () => {
    m.user = null;
    const { html } = serverRender(true);

    expect(has(html, 'not-found')).toBe(true);
    expect(has(html, 'page-loader')).toBe(false);
  });

  test('a profile whose owner blocked the viewer: the blocked panel on the server, not the shell', () => {
    m.user = { ...user, blockedByThem: true };
    const { html } = serverRender(true);

    expect(html).toContain('has blocked you');
    expect(has(html, 'page-loader')).toBe(false);
  });
});
