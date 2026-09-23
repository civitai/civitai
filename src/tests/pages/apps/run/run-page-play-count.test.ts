import { describe, it, expect, vi, beforeEach } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts (and the sibling run-page-maturity test, which this
// harness is cloned from).
import '~/pages/apps/run/[slug]/[[...path]]';

/**
 * App store PLAY COUNT — the recording seam on the run-page SSR resolver.
 *
 * 🔴 WHAT THIS FILE EXISTS TO PIN IS AN ORDERING, NOT A CALL. That
 * `recordAppListingOpen` is invoked somewhere in the resolver is worth almost nothing on
 * its own — a call placed at the TOP of the resolver would satisfy it and would count
 * every 404 as a play, inflating a public number with requests that never rendered an app.
 * So every fail-closed exit is asserted to record NOTHING, and only the successful launch
 * is asserted to record exactly one.
 *
 * The other property here is that the recording is NOT AWAITED. It is asserted
 * behaviourally rather than by reading the source for a `void`: the recorder is made to
 * return a promise that never settles, and the resolver is required to produce its props
 * anyway. An `await` added in front of the call reds that one test — by ASSERTION at the
 * 2 s sentinel, not by hanging the suite; the guard is bounded on purpose. (This sentence
 * previously claimed a hang. It was corrected in the test body and NOT here, which is how a
 * retraction ends up half-applied — see that test for the measured failure text.)
 */

const { capturedResolver } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | ((c: any) => Promise<any>) },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));

const { mockResolvePageBlockBySlug, mockRecordOpen } = vi.hoisted(() => ({
  mockResolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  mockRecordOpen: vi.fn<(...a: any[]) => Promise<void>>(),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolvePageBlockBySlug: mockResolvePageBlockBySlug },
}));
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: mockRecordOpen,
}));

// Real-ish host gate: mature (r/x) requires civitai.red. Same stub as the maturity test,
// because the maturity 404 is one of the exits this file asserts records nothing.
vi.mock('~/server/utils/server-domain', () => ({
  ratingAllowedOnHost: (rating: unknown, host: string) => {
    const mature = typeof rating === 'string' && ['r', 'x'].includes(rating.toLowerCase());
    if (!mature) return true;
    return host === 'civitai.red' || host === 'www.civitai.red';
  },
}));

vi.mock('@mantine/core', () => ({ Box: () => null, useComputedColorScheme: () => 'dark' }));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({ PageBlockHost: () => null }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const PAGE = {
  appBlockId: 'ab_1',
  blockId: 'cool-app',
  appId: 'app_1',
  iframeSrc: 'https://cool-app.civit.ai',
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  name: 'Cool App',
  pageTitle: 'Cool',
  scopes: [],
  contentRating: 'g',
};

function makeCtx(host: string, opts: { slug?: string; features?: any; session?: any } = {}) {
  const { slug = 'cool-app', features = { appBlocks: true, appBlocksPages: true } } = opts;
  // 🔴 `'session' in opts`, NOT a default parameter. A default fires on an explicit
  // `undefined`, so `{ session: undefined }` would silently get the authed default back —
  // which is exactly the value the anonymous case exists to rule out, and it made that
  // test fail against a correct implementation the first time it ran.
  const session = 'session' in opts ? opts.session : ({ user: { id: 7 } } as any);
  return {
    features,
    session,
    ctx: { params: { slug }, req: { headers: { host } }, res: {} },
  };
}

async function loadResolver() {
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn;
}

describe('run-page SSR — play recording', () => {
  beforeEach(() => {
    // NOT capturedResolver — the page module is imported once (ESM cache), so nulling it
    // would lose the resolver for every later test. Same note as the maturity test.
    mockResolvePageBlockBySlug.mockReset();
    mockRecordOpen.mockReset();
    mockRecordOpen.mockResolvedValue(undefined);
  });

  it('records exactly one play for a launch that actually renders', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'g' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.com'));

    expect(result).toHaveProperty('props');
    expect(mockRecordOpen).toHaveBeenCalledTimes(1);
    // The id is the RESOLVED block's, not the request's slug — the two differ whenever a
    // slug is re-pointed, and the rollup joins on `app_listings.app_block_id`.
    expect(mockRecordOpen.mock.calls[0][0]).toMatchObject({ appBlockId: 'ab_1' });
  });

  it('passes the resolved session through, so an authed play is attributable', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'g' });
    const resolver = await loadResolver();
    await resolver(makeCtx('civitai.com'));

    expect(mockRecordOpen.mock.calls[0][0].session).toEqual({ user: { id: 7 } });
  });

  it('records an ANONYMOUS play as an explicit null session, never undefined', async () => {
    // The Tracker distinguishes the two: `undefined` means "resolve it yourself" (a second
    // JWE decrypt on the launch path), `null` means "known anonymous". This route has
    // already resolved the session, so it must assert the latter.
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'g' });
    const resolver = await loadResolver();
    await resolver(makeCtx('civitai.com', { session: undefined }));

    expect(mockRecordOpen).toHaveBeenCalledTimes(1);
    const arg = mockRecordOpen.mock.calls[0][0];
    expect(arg.session).toBeNull();
    expect('session' in arg).toBe(true);
  });

  // ── The three fail-closed exits. Each one is a 404 that must NOT be a play. ──────────

  it('records NOTHING when the feature gate 404s the launch', async () => {
    const resolver = await loadResolver();
    const result = await resolver(
      makeCtx('civitai.com', { features: { appBlocks: false, appBlocksPages: true } })
    );

    expect(result).toEqual({ notFound: true });
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it('records NOTHING when there is no such approved page app', async () => {
    mockResolvePageBlockBySlug.mockResolvedValue(null);
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.com'));

    expect(result).toEqual({ notFound: true });
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it('records NOTHING when the maturity gate 404s a mature app off .red', async () => {
    // 🔴 THE ORDERING ASSERTION. This exit is the LAST one in the resolver, so it is the
    // one a "record it at the top" mistake would sail past while every other test here
    // still passed.
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'x' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx('civitai.com'));

    expect(result).toEqual({ notFound: true });
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it('does not wait for the recording — a hung tracker still serves the app', async () => {
    // 🔴 THE FIRE-AND-FORGET GUARD, asserted behaviourally: the recorder is made to return a
    // promise that never settles, and the resolver must produce its props anyway. An `await`
    // in front of the call reds this test and nothing else — measured.
    //
    // ⚠️ It fails by ASSERTION, not by timeout. An earlier draft of this comment (and the
    // PR body) claimed "by TIMEOUT, the honest failure for that defect"; the `Promise.race`
    // below resolves to the sentinel at 2 s and the expectation rejects it, so the observed
    // failure is `expected 'TIMED_OUT' not to be 'TIMED_OUT'` in ~2005 ms. That is the
    // better behaviour — a bounded, named failure rather than a suite-wide hang — but the
    // description was wrong, so it is corrected rather than made true.
    mockResolvePageBlockBySlug.mockResolvedValue({ ...PAGE, contentRating: 'g' });
    // A promise that never settles IS the fixture; an empty executor is the only way to
    // express it. (The disable must sit on the line DIRECTLY above the code — a two-line
    // comment puts the second line in that slot and the rule fires anyway, which is how
    // this shipped red the first time.)
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    mockRecordOpen.mockReturnValue(new Promise<void>(() => {}));

    const resolver = await loadResolver();
    const result = await Promise.race([
      resolver(makeCtx('civitai.com')),
      new Promise((resolve) => setTimeout(() => resolve('TIMED_OUT'), 2000)),
    ]);

    expect(result).not.toBe('TIMED_OUT');
    expect(result).toHaveProperty('props');
  });
});
