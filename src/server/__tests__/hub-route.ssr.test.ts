import { beforeEach, describe, expect, it, vi } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's
// 60s budget. See vitest.config.mts.
import { getServerSideProps } from '~/pages/hubs/[id]/[[...slug]]';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { Availability } from '~/shared/utils/prisma/enums';
import { encodeHubId } from '~/server/utils/hub-id';

/**
 * `/hubs/<id>` — the SSR WIRING, as distinct from `hubRouteIsDark`'s logic.
 *
 * `user-hub.service.test.ts` proves the predicate answers correctly. This file proves
 * the page CALLS it, and in the right order: the pre-diff code returned `notFound` on
 * the flag before looking anything up, and moving that line back is invisible to every
 * predicate test while it silently kills every hub link preview.
 *
 * The thing under test is the whole reason the feature exists — an unauthenticated
 * fetch of a public hub must come back with meta rather than a 404 — and it is a seam
 * that belonged to no existing file.
 *
 * 🔴 WHAT THIS CANNOT DO. `dbRead` is mocked, so it cannot tell you the Prisma
 * `select` is right: the mock's return value is written by the same author as the
 * code, so a dropped column and a too-generous mock are wrong together and stay green.
 * Dropping `availability` from `getUserHubForRoute`'s select would leave every test
 * here passing while `hubRouteIsDark` read `undefined` and 404'd every public hub in
 * production. The select is pinned by an argument assertion in
 * `user-hub.service.test.ts`; this file covers the wiring.
 */

// The page's `createServerSideProps` wrapper resolves a session; stub it so these
// exercise the resolver rather than auth.
vi.mock('~/server/utils/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

// The flag is read through flipt, and `userHubs` carries no static availability — so
// this is the only way to turn it on or off for a request. Mirrors the mechanism
// `user-hubs-flag-gate.test.ts` uses.
const { fliptResult } = vi.hoisted(() => ({ fliptResult: { value: null as boolean | null } }));
vi.mock('~/server/flipt/client', () => ({
  isFliptSync: () => fliptResult.value,
  ensureFliptInitialized: async () => undefined,
}));

const findFirstHub = dbMock.dbRead.userHub.findFirst;

const HUB_ID = 19;
const HUB_KEY = encodeHubId(HUB_ID);
const SLUG = 'neat-models';

// `getFeatureFlags` memoizes for 10s on (user identity, host, region) and the flipt
// RESULT is not part of that key, so two cases sharing a host would share one answer
// and the second would read whatever the first evaluated. Each case takes its own.
let nextHost = 0;
const run = async (id: string = HUB_KEY) =>
  (await (getServerSideProps as any)({
    params: { id, slug: [SLUG] },
    req: {
      url: `/hubs/${id}/${SLUG}`,
      headers: { host: `case-${nextHost++}.civitai.com`, 'cf-ipcountry': 'US' },
      cookies: {},
    },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: {},
    resolvedUrl: `/hubs/${id}/${SLUG}`,
  })) as any;

const hubRow = (availability: Availability) => ({
  id: HUB_ID,
  key: HUB_KEY,
  name: 'Neat models!',
  availability,
  metadata: { description: 'Models I think are neat' },
});

beforeEach(() => {
  findFirstHub.mockReset();
});

describe('/hubs/<id> — getServerSideProps wiring', () => {
  it('serves a PUBLIC hub to a signed-out request with the flag off, carrying its meta', async () => {
    // The feature. A link unfurler fetches this URL with no session, so a 404 here is
    // the difference between a hub link previewing and producing nothing at all.
    fliptResult.value = false;
    findFirstHub.mockResolvedValue(hubRow(Availability.Public));

    const result = await run();

    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeUndefined();
    expect(result.props).toMatchObject({
      hubMeta: { name: 'Neat models!', description: 'Models I think are neat' },
    });
  });

  it('404s a BARE INTEGER, which is what the pre-encoding links carried', async () => {
    // The encoding buys nothing if the int still resolves: `UserHub.id` is a dense
    // autoincrement and this route answers unauthenticated, so accepting it back
    // leaves every public hub walkable by counting. The hub lookup must not even run.
    fliptResult.value = false;
    findFirstHub.mockResolvedValue(hubRow(Availability.Public));

    expect(await run(String(HUB_ID))).toEqual({ notFound: true });
    expect(findFirstHub).not.toHaveBeenCalled();
  });

  it('still 404s a PRIVATE hub with the flag off', async () => {
    fliptResult.value = false;
    findFirstHub.mockResolvedValue(hubRow(Availability.Private));

    expect(await run()).toEqual({ notFound: true });
  });

  it('404s an id that resolves to nothing, the same answer a private hub gets', async () => {
    // Same shape as the case above on purpose: a stranger must not be able to tell a
    // private hub from one that never existed.
    fliptResult.value = false;
    findFirstHub.mockResolvedValue(null);

    expect(await run()).toEqual({ notFound: true });
  });

  it('serves a PRIVATE hub the viewer may open once the flag is on', async () => {
    // The control for the two above: without it they would pass against a resolver
    // that 404s everything, which is exactly the pre-diff behaviour.
    fliptResult.value = true;
    findFirstHub.mockResolvedValue(hubRow(Availability.Private));

    const result = await run();

    expect(result.notFound).toBeUndefined();
    expect(result.props).toMatchObject({ hubMeta: { name: 'Neat models!' } });
  });
});
