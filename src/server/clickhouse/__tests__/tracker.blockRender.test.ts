import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Blocks Analytics Phase 2 — Tracker.blockRender() contract.
 *
 * Exercises the REAL Tracker class (not a stub) and asserts the wire payload it
 * POSTs to the tracker service:
 *   - it dispatches to the `blockRenders` table (track('blockRenders', ...)),
 *   - the actor (userId/ip/userAgent) is stamped from the resolved session —
 *     userId comes from session.user.id, NOT from the client,
 *   - isAnon is carried through verbatim from the caller (the tRPC procedure
 *     derives it server-side; the Tracker just forwards it),
 *   - the three identifiers pass through unchanged.
 *
 * We mock the env so CLICKHOUSE_TRACKER_URL is set (otherwise send() no-ops) and
 * capture the POST body via a stubbed global fetch.
 */

vi.mock('~/env/server', () => ({
  env: {
    CLICKHOUSE_TRACKER_URL: 'http://tracker.test',
    // Unset so the module-level clickhouse client never connects.
    CLICKHOUSE_HOST: undefined,
    CLICKHOUSE_USERNAME: undefined,
    CLICKHOUSE_PASSWORD: undefined,
    IS_BUILD: true,
    // createLogger (imported transitively by client.ts) reads env.LOGGING.
    LOGGING: [],
  },
}));
vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const [, init] = call as [string, { body: string }];
  return JSON.parse(init.body);
}

describe('Tracker.blockRender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs to the blockRenders table with the identifiers + carried isAnon', async () => {
    // Session passed via the constructor (3rd arg) so resolveSession() doesn't
    // re-fetch — userId is stamped from session.user.id.
    const tracker = new Tracker(undefined, undefined, { user: { id: 555 } } as never);
    await tracker.blockRender({
      appBlockId: 'ab_1',
      blockInstanceId: 'inst_1',
      slotId: 'model.sidebar_top',
      isAnon: false,
    });
    // send() is fire-and-forget internally; allow the microtask queue to flush.
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://tracker.test/track/blockRenders');

    const body = lastFetchBody(fetchMock);
    expect(body).toMatchObject({
      appBlockId: 'ab_1',
      blockInstanceId: 'inst_1',
      slotId: 'model.sidebar_top',
      isAnon: false,
      userId: 555, // stamped server-side from the session, not the client
    });
  });

  it('stamps userId=0 for an anonymous session and carries isAnon:true', async () => {
    const tracker = new Tracker(undefined, undefined, null);
    await tracker.blockRender({
      appBlockId: 'ab_2',
      blockInstanceId: 'inst_2',
      slotId: 'app.page',
      isAnon: true,
    });
    await new Promise((r) => setImmediate(r));

    const body = lastFetchBody(fetchMock);
    expect(body).toMatchObject({
      appBlockId: 'ab_2',
      blockInstanceId: 'inst_2',
      slotId: 'app.page',
      isAnon: true,
      userId: 0,
    });
  });
});
