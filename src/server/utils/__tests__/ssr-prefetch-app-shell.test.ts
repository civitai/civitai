import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SSR-prefetch of the universal app-shell tRPC queries (see
 * `prefetchAppShellQueries` + the flag-gated call in `createServerSideProps`,
 * `src/server/utils/server-side-helpers.ts`).
 *
 * The lever: each prefetched shell query rides down in the page's dehydrated
 * `trpcState` and hydrates on the client (which runs `staleTime: Infinity`, so
 * the hydrated value sticks and the ~188ms client→origin round-trip is saved)
 * instead of firing on mount. This pins the safety contract:
 *   - the SAFE session queries are prefetched on full SSR when the flag is on,
 *   - nothing is prefetched on a client-nav `/_next/data` fetch (no `ssg`),
 *   - the flag OFF prefetches nothing (but SSG/`trpcState` is unaffected),
 *   - anon sessions get no user-scoped prefetch,
 *   - `buzz.getUserMultipliers` is gated on the `buzz` flag,
 *   - a failing shell query degrades to client-fetch — it never 500s SSR.
 *
 * server-side-helpers.ts pulls the whole app router + clickhouse + auth graph at
 * module load; stub those so the module imports in isolation and the tRPC SSG
 * helper is a spy we can assert `.prefetch()` calls against.
 */

const h = vi.hoisted(() => {
  const checkNotifications = vi.fn(async () => undefined);
  const getBookmarkCollections = vi.fn(async () => undefined);
  const getUserMultipliers = vi.fn(async () => undefined);
  const dehydrate = vi.fn(() => ({ mock: 'trpcState' }));
  // Shape mirrors the real tRPC SSG proxy for exactly the procedures we prefetch.
  const fakeSsg = {
    user: {
      checkNotifications: { prefetch: checkNotifications },
      getBookmarkCollections: { prefetch: getBookmarkCollections },
    },
    buzz: {
      getUserMultipliers: { prefetch: getUserMultipliers },
    },
    dehydrate,
  };
  return {
    checkNotifications,
    getBookmarkCollections,
    getUserMultipliers,
    dehydrate,
    fakeSsg,
    createServerSideHelpers: vi.fn(() => fakeSsg),
    getServerAuthSession: vi.fn(),
    getFeatureFlagsAsync: vi.fn(),
  };
});

vi.mock('@trpc/react-query/server', () => ({ createServerSideHelpers: h.createServerSideHelpers }));
vi.mock('~/server/routers', () => ({ appRouter: {} }));
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsAsync: h.getFeatureFlagsAsync,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: h.getServerAuthSession,
}));
vi.mock('~/server/utils/server-domain', () => ({ getRequestDomainColor: vi.fn(() => 'blue') }));

import { createServerSideProps, prefetchAppShellQueries } from '../server-side-helpers';

type AnyContext = Parameters<ReturnType<typeof createServerSideProps>>[0];

const authedSession = { user: { id: 1 } } as any;

function makeContext(url: string): AnyContext {
  return {
    req: { url, headers: { host: 'civitai.com' } },
    res: { setHeader: vi.fn() },
    resolvedUrl: url,
    query: {},
  } as any;
}

function features(overrides: Record<string, boolean> = {}) {
  return { ssrPrefetchShell: true, buzz: true, ...overrides } as any;
}

const okResolver = async () => ({ props: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  h.getServerAuthSession.mockResolvedValue(authedSession);
  h.getFeatureFlagsAsync.mockResolvedValue(features());
});

describe('createServerSideProps — SSR app-shell prefetch', () => {
  it('prefetches the SAFE session shell queries on full SSR when the flag is on', async () => {
    const gssp = createServerSideProps({ useSSG: true, resolver: okResolver });
    const res: any = await gssp(makeContext('/models'));

    expect(h.checkNotifications).toHaveBeenCalledTimes(1);
    expect(h.getBookmarkCollections).toHaveBeenCalledTimes(1);
    expect(h.getUserMultipliers).toHaveBeenCalledTimes(1);
    // input-less: prefetch called with no argument so the dehydrated key matches
    // the client `useQuery(undefined)` exactly.
    expect(h.checkNotifications).toHaveBeenCalledWith();
    // hydrated cache rides down in trpcState.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
  });

  it('does NOT prefetch (or build an SSG helper) on a client-nav /_next/data fetch', async () => {
    const gssp = createServerSideProps({ useSSG: true, resolver: okResolver });
    const res: any = await gssp(makeContext('/_next/data/build-id/models.json'));

    expect(h.createServerSideHelpers).not.toHaveBeenCalled();
    expect(h.checkNotifications).not.toHaveBeenCalled();
    expect(h.getBookmarkCollections).not.toHaveBeenCalled();
    expect(h.getUserMultipliers).not.toHaveBeenCalled();
    expect(res.props.trpcState).toBeUndefined();
  });

  it('prefetches nothing when the flag is OFF, but still dehydrates SSG state', async () => {
    h.getFeatureFlagsAsync.mockResolvedValue(features({ ssrPrefetchShell: false }));
    const gssp = createServerSideProps({ useSSG: true, resolver: okResolver });
    const res: any = await gssp(makeContext('/models'));

    expect(h.checkNotifications).not.toHaveBeenCalled();
    expect(h.getBookmarkCollections).not.toHaveBeenCalled();
    expect(h.getUserMultipliers).not.toHaveBeenCalled();
    // useSSG still builds the helper — the flag gates only the shell prefetch.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
  });

  it('does not prefetch user-scoped queries for an anonymous session', async () => {
    h.getServerAuthSession.mockResolvedValue(null);
    const gssp = createServerSideProps({ useSSG: true, resolver: okResolver });
    await gssp(makeContext('/models'));

    expect(h.checkNotifications).not.toHaveBeenCalled();
    expect(h.getBookmarkCollections).not.toHaveBeenCalled();
    expect(h.getUserMultipliers).not.toHaveBeenCalled();
  });

  it('gates buzz.getUserMultipliers on the buzz feature flag', async () => {
    h.getFeatureFlagsAsync.mockResolvedValue(features({ buzz: false }));
    const gssp = createServerSideProps({ useSSG: true, resolver: okResolver });
    await gssp(makeContext('/models'));

    expect(h.checkNotifications).toHaveBeenCalledTimes(1);
    expect(h.getBookmarkCollections).toHaveBeenCalledTimes(1);
    expect(h.getUserMultipliers).not.toHaveBeenCalled();
  });

  it('degrades gracefully — a failing shell prefetch never rejects out of SSR', async () => {
    h.checkNotifications.mockRejectedValueOnce(new Error('backend 500'));
    const gssp = createServerSideProps({ useSSG: true, resolver: okResolver });

    const res: any = await gssp(makeContext('/models'));

    // SSR still resolves with a normal props payload (no throw / 500).
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
    // the other shell queries were still attempted (allSettled, not fail-fast).
    expect(h.getBookmarkCollections).toHaveBeenCalledTimes(1);
    expect(h.getUserMultipliers).toHaveBeenCalledTimes(1);
  });

  it('does not prefetch when useSSG is not set (no SSG helper at all)', async () => {
    const gssp = createServerSideProps({ resolver: okResolver });
    const res: any = await gssp(makeContext('/models'));

    expect(h.createServerSideHelpers).not.toHaveBeenCalled();
    expect(h.checkNotifications).not.toHaveBeenCalled();
    expect(res.props.trpcState).toBeUndefined();
  });
});

describe('prefetchAppShellQueries — unit', () => {
  it('prefetches all three SAFE queries for an authed session with buzz on', async () => {
    await prefetchAppShellQueries(h.fakeSsg as any, authedSession, features());
    expect(h.checkNotifications).toHaveBeenCalledTimes(1);
    expect(h.getBookmarkCollections).toHaveBeenCalledTimes(1);
    expect(h.getUserMultipliers).toHaveBeenCalledTimes(1);
  });

  it('prefetches nothing for an anonymous session', async () => {
    await prefetchAppShellQueries(h.fakeSsg as any, null, features());
    expect(h.checkNotifications).not.toHaveBeenCalled();
    expect(h.getBookmarkCollections).not.toHaveBeenCalled();
    expect(h.getUserMultipliers).not.toHaveBeenCalled();
  });

  it('resolves (never throws) when a prefetch rejects', async () => {
    h.getBookmarkCollections.mockRejectedValueOnce(new Error('db down'));
    await expect(
      prefetchAppShellQueries(h.fakeSsg as any, authedSession, features())
    ).resolves.toBeUndefined();
  });
});
