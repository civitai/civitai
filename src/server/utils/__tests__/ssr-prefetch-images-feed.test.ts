import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ImageSort, NsfwLevel } from '~/server/common/enums';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  resolveBrowsingSettingsAddons,
  type BrowsingSettingsAddon,
} from '~/shared/constants/browsing-settings-addons';

/**
 * SSR-prefetch of the `/images` feed page's INITIAL `image.getInfinite` query
 * (see `prefetchImagesFeedQueries` in `src/server/utils/server-side-helpers.ts`,
 * wired flag-gated into the `/images` GSSP resolver in `src/pages/images/index.tsx`).
 *
 * The lever: the initial feed query — the page's first, HEAVIEST client fetch
 * (`heavyProcedure`, bulkhead-slotted) — rides down in the page's dehydrated
 * `trpcState` and hydrates on the client (`staleTime: Infinity`, so the hydrated
 * value sticks and the ~188ms client→origin round-trip is saved) instead of
 * firing on mount. Because a mismatched heavy prefetch is pure cost (wasted work
 * + a burned bulkhead slot), this pins the safety + key-match contract:
 *   - ANON-ONLY: the exact client input is only server-reproducible for anon
 *     (deterministic browsingLevel + default filters + resolved addons); authed
 *     requests are never prefetched (their localStorage/browsing state diverges),
 *   - the prefetched input reproduces the client `useInfiniteQuery` key EXACTLY
 *     (default filters + `publicBrowsingLevelsFlag` + `include:['cosmetics']` +
 *     the addon-resolved `excludedTagIds`/`disablePoi`/`disableMinor`),
 *   - `prefetchInfinite` (not `.prefetch`) is used so the dehydrated shape matches
 *     the client `useInfiniteQuery`,
 *   - nothing is prefetched on a client-nav `/_next/data` fetch (no `ssg`),
 *   - the flag OFF prefetches nothing (SSG/`trpcState` unaffected),
 *   - a failing addon fetch skips the prefetch (never fire a wrong-key heavy query),
 *   - a failing / never-settling feed query degrades to client-fetch — it never
 *     500s or hangs the `/images` SSR (bounded by the 300ms shared deadline).
 *
 * server-side-helpers.ts pulls the whole app router + clickhouse + auth graph at
 * module load; stub those so it imports in isolation and the tRPC SSG helper is a
 * spy. `~/server/services/system-cache` (redis) is lazy-imported by the helper,
 * so it is mocked here too.
 */

const h = vi.hoisted(() => {
  const getInfinitePrefetch = vi.fn(async () => undefined);
  // shell-prefetch procedures (createServerSideProps also calls the shell
  // prefetch; stubbed inert — driven OFF via the flag / anon session).
  const checkNotifications = vi.fn(async () => undefined);
  const getBookmarkCollections = vi.fn(async () => undefined);
  const getUserMultipliers = vi.fn(async () => undefined);
  const dehydrate = vi.fn(() => ({ mock: 'trpcState' }));
  const fakeSsg = {
    image: {
      getInfinite: { prefetchInfinite: getInfinitePrefetch },
    },
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
    getInfinitePrefetch,
    dehydrate,
    fakeSsg,
    createServerSideHelpers: vi.fn(() => fakeSsg),
    getServerAuthSession: vi.fn(),
    getFeatureFlagsAsync: vi.fn(),
    getBrowsingSettingAddons: vi.fn(),
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
vi.mock('~/server/services/system-cache', () => ({
  getBrowsingSettingAddons: h.getBrowsingSettingAddons,
}));

import { createServerSideProps, prefetchImagesFeedQueries } from '../server-side-helpers';

type AnyContext = Parameters<ReturnType<typeof createServerSideProps>>[0];

const authedSession = { user: { id: 1 } } as any;

// A representative addon list (mirrors the real-person rule in
// DEFAULT_BROWSING_SETTINGS_ADDONS) so the resolver injects a NON-empty,
// order-sensitive excludedTagIds + disablePoi at the anon PG level.
const ADDONS: BrowsingSettingsAddon[] = [
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    disablePoi: true,
    excludedTagIds: [5161, 5162, 5188],
  },
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX], // does NOT apply at PG
    disableMinor: true,
    excludedTagIds: [5351],
  },
];

// The EXACT input `useQueryImages` builds for a default anonymous `/images` load,
// reproduced here from the SAME public functions the client uses, so this asserts
// the server prefetch key == the client `useInfiniteQuery` key.
function expectedAnonInput(addons: BrowsingSettingsAddon[]) {
  const resolved = resolveBrowsingSettingsAddons(addons, publicBrowsingLevelsFlag, {
    isModerator: false,
  });
  return {
    period: MetricTimeframe.Week,
    sort: ImageSort.MostReactions,
    types: [MediaType.image],
    withMeta: false,
    browsingLevel: publicBrowsingLevelsFlag,
    include: ['cosmetics'],
    excludedTagIds: resolved.excludedTagIds,
    disablePoi: resolved.disablePoi,
    disableMinor: resolved.disableMinor,
  };
}

function makeContext(url: string): AnyContext {
  return {
    req: { url, headers: { host: 'civitai.com' } },
    res: { setHeader: vi.fn() },
    resolvedUrl: url,
    query: {},
  } as any;
}

// Mirrors the `/images` GSSP wiring: flag-gated, anon-only, runs only when the
// SSG helper exists (full SSR), never on client-nav.
function imagesResolver() {
  return async ({ session, features, ssg }: any) => {
    if (ssg && features?.ssrPrefetchImagesFeed) {
      await prefetchImagesFeedQueries(ssg, session ?? null);
    }
    return { props: {} } as any;
  };
}

function features(overrides: Record<string, boolean> = {}) {
  return {
    ssrPrefetchImagesFeed: true,
    ssrPrefetchShell: false, // keep the shell prefetch inert in these tests
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: anonymous request.
  h.getServerAuthSession.mockResolvedValue(null);
  h.getFeatureFlagsAsync.mockResolvedValue(features());
  h.getBrowsingSettingAddons.mockResolvedValue(ADDONS);
});

describe('createServerSideProps — images feed SSR prefetch (integration)', () => {
  it('prefetches the initial anon feed query with the EXACT client key on full SSR when the flag is on', async () => {
    const gssp = createServerSideProps({ useSSG: true, resolver: imagesResolver() });
    const res: any = await gssp(makeContext('/images'));

    expect(h.getInfinitePrefetch).toHaveBeenCalledTimes(1);
    // The reproduced input deep-equals the client `useInfiniteQuery` input.
    expect(h.getInfinitePrefetch).toHaveBeenCalledWith(expectedAnonInput(ADDONS));
    // hydrated cache rides down in trpcState.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
  });

  it('does NOT prefetch (or build an SSG helper) on a client-nav /_next/data fetch', async () => {
    const gssp = createServerSideProps({ useSSG: true, resolver: imagesResolver() });
    const res: any = await gssp(makeContext('/_next/data/build-id/images.json'));

    expect(h.createServerSideHelpers).not.toHaveBeenCalled();
    expect(h.getInfinitePrefetch).not.toHaveBeenCalled();
    expect(res.props.trpcState).toBeUndefined();
  });

  it('prefetches nothing when the flag is OFF, but still dehydrates SSG state', async () => {
    h.getFeatureFlagsAsync.mockResolvedValue(features({ ssrPrefetchImagesFeed: false }));
    const gssp = createServerSideProps({ useSSG: true, resolver: imagesResolver() });
    const res: any = await gssp(makeContext('/images'));

    expect(h.getInfinitePrefetch).not.toHaveBeenCalled();
    // useSSG still builds the helper — the flag gates only the feed prefetch.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
  });

  it('does NOT prefetch for an authed session (anon-only), but still dehydrates SSG state', async () => {
    h.getServerAuthSession.mockResolvedValue(authedSession);
    const gssp = createServerSideProps({ useSSG: true, resolver: imagesResolver() });
    const res: any = await gssp(makeContext('/images'));

    expect(h.getInfinitePrefetch).not.toHaveBeenCalled();
    expect(h.getBrowsingSettingAddons).not.toHaveBeenCalled();
    // The authed render path is entirely unchanged — props/session still returned.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
    expect(res.props.session).toEqual(authedSession);
  });

  it('degrades gracefully — a failing feed prefetch never rejects out of SSR', async () => {
    h.getInfinitePrefetch.mockRejectedValueOnce(new Error('backend 500'));
    const gssp = createServerSideProps({ useSSG: true, resolver: imagesResolver() });

    const res: any = await gssp(makeContext('/images'));

    // SSR still resolves with a normal props payload (no throw / 500).
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
    expect(h.getInfinitePrefetch).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchImagesFeedQueries — unit', () => {
  it('prefetches the initial feed query for an anon session with the exact reproduced input', async () => {
    await prefetchImagesFeedQueries(h.fakeSsg as any, null);
    expect(h.getInfinitePrefetch).toHaveBeenCalledTimes(1);
    expect(h.getInfinitePrefetch).toHaveBeenCalledWith(expectedAnonInput(ADDONS));
  });

  it('resolves the addon-derived fields (non-empty excludedTagIds + disablePoi) at the anon PG level', async () => {
    await prefetchImagesFeedQueries(h.fakeSsg as any, null);
    const input = h.getInfinitePrefetch.mock.calls[0][0] as any;
    // Only the PG-applicable addon contributes; order is preserved for the hash.
    expect(input.excludedTagIds).toEqual([5161, 5162, 5188]);
    expect(input.disablePoi).toBe(true);
    expect(input.disableMinor).toBe(false); // R+ rule does not apply at PG
    expect(input.browsingLevel).toBe(publicBrowsingLevelsFlag);
    expect(input.include).toEqual(['cosmetics']);
  });

  it('prefetches nothing for an authed session (anon-only scope)', async () => {
    await prefetchImagesFeedQueries(h.fakeSsg as any, authedSession);
    expect(h.getInfinitePrefetch).not.toHaveBeenCalled();
    expect(h.getBrowsingSettingAddons).not.toHaveBeenCalled();
  });

  it('skips the prefetch (never fires a wrong-key heavy query) when the addon fetch fails', async () => {
    h.getBrowsingSettingAddons.mockRejectedValueOnce(new Error('redis down'));
    await expect(prefetchImagesFeedQueries(h.fakeSsg as any, null)).resolves.toBeUndefined();
    expect(h.getInfinitePrefetch).not.toHaveBeenCalled();
  });

  it('resolves (never throws) when the feed prefetch rejects', async () => {
    h.getInfinitePrefetch.mockRejectedValueOnce(new Error('meili down'));
    await expect(prefetchImagesFeedQueries(h.fakeSsg as any, null)).resolves.toBeUndefined();
  });

  it('resolves via the deadline (never hangs SSR) when the feed prefetch never settles', async () => {
    vi.useFakeTimers();
    try {
      h.getInfinitePrefetch.mockImplementationOnce(() => new Promise<undefined>(() => {}));

      const pending = prefetchImagesFeedQueries(h.fakeSsg as any, null);
      let settled = false;
      const tracked = pending.then(() => {
        settled = true;
      });

      // The addon fetch is an awaited microtask before the deadline race starts;
      // flush it so the timers below drive the hung prefetch, not the addon await.
      await vi.advanceTimersByTimeAsync(0);
      // Not resolved before the deadline elapses…
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);

      // …but the 300ms deadline resolves it (never throws) with the task still hung.
      await vi.advanceTimersByTimeAsync(1);
      await tracked;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
