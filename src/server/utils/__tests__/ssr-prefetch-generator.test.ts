import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';

/**
 * SSR-prefetch of the generator page's static init queries (see
 * `prefetchGeneratorQueries` in `src/server/utils/server-side-helpers.ts`, wired
 * flag-gated into the `/generate` GSSP resolver in `src/pages/generate/index.tsx`).
 *
 * The lever: each prefetched generator query rides down in the page's dehydrated
 * `trpcState` and hydrates on the client (which runs `staleTime: Infinity`, so
 * the hydrated value sticks and the ~188ms client→origin round-trip is saved)
 * instead of firing on mount from the always-open generation sidebar. This pins
 * the safety contract:
 *   - the SAFE session queries are prefetched on full SSR when the flag is on,
 *   - `generationPreset.getOwn` / `challenge.getInfinite` are gated on the flags
 *     that render their triggers, and challenge uses the EXACT client input,
 *   - `orchestrator.whatIfFromGraph` is NEVER prefetched (client-graph state),
 *   - nothing is prefetched on a client-nav `/_next/data` fetch (no `ssg`),
 *   - the flag OFF prefetches nothing (but SSG/`trpcState` is unaffected),
 *   - anon sessions get no user-scoped prefetch,
 *   - a failing / slow query degrades to client-fetch — it never 500s or hangs
 *     the money-path generator SSR (bounded by the shared deadline).
 *
 * server-side-helpers.ts pulls the whole app router + clickhouse + auth graph at
 * module load; stub those so the module imports in isolation and the tRPC SSG
 * helper is a spy we can assert `.prefetch()` calls against.
 */

const h = vi.hoisted(() => {
  const userRewardDetails = vi.fn(async () => undefined);
  const generationPresetGetOwn = vi.fn(async () => undefined);
  const challengeGetInfinite = vi.fn(async () => undefined);
  const whatIfFromGraph = vi.fn(async () => undefined);
  // shell-prefetch procedures (createServerSideProps also calls the shell
  // prefetch; stubbed so it is inert here — we drive it OFF via the flag).
  const checkNotifications = vi.fn(async () => undefined);
  const getBookmarkCollections = vi.fn(async () => undefined);
  const getUserMultipliers = vi.fn(async () => undefined);
  const dehydrate = vi.fn(() => ({ mock: 'trpcState' }));
  const fakeSsg = {
    user: {
      userRewardDetails: { prefetch: userRewardDetails },
      checkNotifications: { prefetch: checkNotifications },
      getBookmarkCollections: { prefetch: getBookmarkCollections },
    },
    generationPreset: {
      getOwn: { prefetch: generationPresetGetOwn },
    },
    challenge: {
      getInfinite: { prefetch: challengeGetInfinite },
    },
    orchestrator: {
      whatIfFromGraph: { prefetch: whatIfFromGraph },
    },
    buzz: {
      getUserMultipliers: { prefetch: getUserMultipliers },
    },
    dehydrate,
  };
  return {
    userRewardDetails,
    generationPresetGetOwn,
    challengeGetInfinite,
    whatIfFromGraph,
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

import {
  createServerSideProps,
  prefetchGeneratorQueries,
} from '../server-side-helpers';

type AnyContext = Parameters<ReturnType<typeof createServerSideProps>>[0];

const authedSession = { user: { id: 1 } } as any;

// The exact static input `useGetActiveChallenges` passes to `challenge.getInfinite`.
const EXPECTED_CHALLENGE_INPUT = {
  status: [ChallengeStatus.Active],
  source: [ChallengeSource.System],
  excludeEventChallenges: true,
  limit: 2,
};

function makeContext(url: string): AnyContext {
  return {
    req: { url, headers: { host: 'civitai.com' } },
    res: { setHeader: vi.fn() },
    resolvedUrl: url,
    query: {},
  } as any;
}

// Mirrors the `/generate` GSSP wiring (src/pages/generate/index.tsx): flag-gated,
// runs only when the SSG helper exists (full SSR), never on client-nav.
function generatorResolver() {
  return async ({ session, features, ssg }: any) => {
    if (ssg && features?.ssrPrefetchGenerator) {
      await prefetchGeneratorQueries(ssg, session, features);
    }
    return { props: {} } as any;
  };
}

function features(overrides: Record<string, boolean> = {}) {
  return {
    ssrPrefetchGenerator: true,
    ssrPrefetchShell: false, // keep the shell prefetch inert in these tests
    generationPresets: true,
    challengePlatform: true,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getServerAuthSession.mockResolvedValue(authedSession);
  h.getFeatureFlagsAsync.mockResolvedValue(features());
});

describe('createServerSideProps — generator SSR prefetch (integration)', () => {
  it('prefetches the generator init queries on full SSR when the flag is on', async () => {
    const gssp = createServerSideProps({ useSSG: true, resolver: generatorResolver() });
    const res: any = await gssp(makeContext('/generate'));

    expect(h.userRewardDetails).toHaveBeenCalledTimes(1);
    expect(h.userRewardDetails).toHaveBeenCalledWith(); // input-less
    expect(h.generationPresetGetOwn).toHaveBeenCalledTimes(1);
    expect(h.generationPresetGetOwn).toHaveBeenCalledWith(); // input-less
    // challenge.getInfinite uses the EXACT client input so the key matches.
    expect(h.challengeGetInfinite).toHaveBeenCalledTimes(1);
    expect(h.challengeGetInfinite).toHaveBeenCalledWith(EXPECTED_CHALLENGE_INPUT);
    // whatIf is NEVER prefetched (depends on client-side generation-graph state).
    expect(h.whatIfFromGraph).not.toHaveBeenCalled();
    // hydrated cache rides down in trpcState.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
  });

  it('does NOT prefetch (or build an SSG helper) on a client-nav /_next/data fetch', async () => {
    const gssp = createServerSideProps({ useSSG: true, resolver: generatorResolver() });
    const res: any = await gssp(makeContext('/_next/data/build-id/generate.json'));

    expect(h.createServerSideHelpers).not.toHaveBeenCalled();
    expect(h.userRewardDetails).not.toHaveBeenCalled();
    expect(h.generationPresetGetOwn).not.toHaveBeenCalled();
    expect(h.challengeGetInfinite).not.toHaveBeenCalled();
    expect(res.props.trpcState).toBeUndefined();
  });

  it('prefetches nothing when the flag is OFF, but still dehydrates SSG state', async () => {
    h.getFeatureFlagsAsync.mockResolvedValue(features({ ssrPrefetchGenerator: false }));
    const gssp = createServerSideProps({ useSSG: true, resolver: generatorResolver() });
    const res: any = await gssp(makeContext('/generate'));

    expect(h.userRewardDetails).not.toHaveBeenCalled();
    expect(h.generationPresetGetOwn).not.toHaveBeenCalled();
    expect(h.challengeGetInfinite).not.toHaveBeenCalled();
    // useSSG still builds the helper — the flag gates only the generator prefetch.
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
  });

  it('degrades gracefully — a failing generator prefetch never rejects out of SSR', async () => {
    h.userRewardDetails.mockRejectedValueOnce(new Error('backend 500'));
    const gssp = createServerSideProps({ useSSG: true, resolver: generatorResolver() });

    const res: any = await gssp(makeContext('/generate'));

    // SSR still resolves with a normal props payload (no throw / 500).
    expect(res.props.trpcState).toEqual({ mock: 'trpcState' });
    // the other queries were still attempted (allSettled, not fail-fast).
    expect(h.generationPresetGetOwn).toHaveBeenCalledTimes(1);
    expect(h.challengeGetInfinite).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchGeneratorQueries — unit', () => {
  it('prefetches all generator queries for an authed session with both render flags on', async () => {
    await prefetchGeneratorQueries(h.fakeSsg as any, authedSession, features());
    expect(h.userRewardDetails).toHaveBeenCalledTimes(1);
    expect(h.generationPresetGetOwn).toHaveBeenCalledTimes(1);
    expect(h.challengeGetInfinite).toHaveBeenCalledTimes(1);
    expect(h.challengeGetInfinite).toHaveBeenCalledWith(EXPECTED_CHALLENGE_INPUT);
    expect(h.whatIfFromGraph).not.toHaveBeenCalled();
  });

  it('prefetches nothing for an anonymous session', async () => {
    await prefetchGeneratorQueries(h.fakeSsg as any, null, features());
    expect(h.userRewardDetails).not.toHaveBeenCalled();
    expect(h.generationPresetGetOwn).not.toHaveBeenCalled();
    expect(h.challengeGetInfinite).not.toHaveBeenCalled();
  });

  it('gates generationPreset.getOwn on the generationPresets flag', async () => {
    await prefetchGeneratorQueries(h.fakeSsg as any, authedSession, features({ generationPresets: false }));
    expect(h.userRewardDetails).toHaveBeenCalledTimes(1);
    expect(h.generationPresetGetOwn).not.toHaveBeenCalled();
    expect(h.challengeGetInfinite).toHaveBeenCalledTimes(1);
  });

  it('gates challenge.getInfinite on the challengePlatform flag', async () => {
    await prefetchGeneratorQueries(h.fakeSsg as any, authedSession, features({ challengePlatform: false }));
    expect(h.userRewardDetails).toHaveBeenCalledTimes(1);
    expect(h.generationPresetGetOwn).toHaveBeenCalledTimes(1);
    expect(h.challengeGetInfinite).not.toHaveBeenCalled();
  });

  it('resolves (never throws) when a prefetch rejects', async () => {
    h.generationPresetGetOwn.mockRejectedValueOnce(new Error('db down'));
    await expect(
      prefetchGeneratorQueries(h.fakeSsg as any, authedSession, features())
    ).resolves.toBeUndefined();
  });

  it('resolves via the deadline (never hangs SSR) when a prefetch never settles', async () => {
    vi.useFakeTimers();
    try {
      // A prefetch that hangs forever — without the deadline this would block SSR.
      h.userRewardDetails.mockImplementationOnce(() => new Promise<undefined>(() => {}));

      const pending = prefetchGeneratorQueries(h.fakeSsg as any, authedSession, features());
      let settled = false;
      const tracked = pending.then(() => {
        settled = true;
      });

      // Not resolved before the deadline elapses…
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);

      // …but the 300ms deadline resolves it (never throws) even with a task still hung.
      await vi.advanceTimersByTimeAsync(1);
      await tracked;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
