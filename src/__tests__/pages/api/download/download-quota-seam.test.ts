import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The two SEAMS of the anonymous download quota — the joints that no
 * single-component suite owns.
 *
 * `fetchDownloadCount` is well covered in isolation (`download-count.test.ts`)
 * and `/api/download/models/[modelVersionId]` is well covered in isolation
 * (`model-version-blocklist.test.ts`). Neither can see the wiring BETWEEN them,
 * because the endpoint suite mocks `createLimiter` wholesale and so never
 * reaches the counter at all. Measured: rebinding the route's
 * `fetchCount: fetchDownloadCount` to `async () => 0` — a quota that counts
 * nothing and can never trip — passed every one of those suites.
 *
 * So this file asserts RELATIONSHIPS rather than components:
 *
 *   1. WIRING  — the function the route hands its limiter is the real
 *      `fetchDownloadCount`, and it genuinely queries rather than answering a
 *      constant.
 *   2. KEY     — the value the quota is looked up under is the NORMALIZED
 *      derived address, i.e. exactly `getTrustedClientIp(req)`, not the raw
 *      socket text.
 *
 * (2) is the half of the read/write asymmetry documented in `download-count.ts`
 * that this repo controls. The write side derives its own address and is not
 * changed here; the last test states the consequence in executable form.
 */

const {
  limiterOptions,
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
  mockChQuery,
} = vi.hoisted(() => ({
  // A plain object, NOT a vi.fn: `createLimiter` is called once at module-eval
  // time of the route, so a spy's call record would be wiped by the
  // `clearAllMocks` in beforeEach before any test could read it.
  limiterOptions: {} as Record<string, unknown>,
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockChQuery: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: mockGetFileForModelVersion,
}));

vi.mock('~/server/services/user.service', () => ({
  bustUserDownloadsCache: vi.fn().mockResolvedValue(undefined),
}));

// A REAL-shaped clickhouse client, unlike the sibling endpoint suite which sets
// it to `undefined`. `fetchDownloadCount` short-circuits to 0 when there is no
// client, so a suite that stubs it out cannot tell a wired counter from an
// unwired one.
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const text =
        typeof strings === 'string'
          ? strings
          : strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '');
      return mockChQuery(text);
    },
  },
  Tracker: class {
    modelVersionEvent = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/redis/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  return { REDIS_SYS_KEYS: make(), REDIS_KEYS: make(), redis: {}, sysRedis: {} };
});

// Capture the options the route builds its limiter with, then return a stub so
// the handler still runs. The capture is what makes the wiring observable.
vi.mock('~/server/utils/rate-limiting', () => ({
  createLimiter: (opts: Record<string, unknown>) => {
    Object.assign(limiterOptions, opts);
    return {
      hasExceededLimit: mockHasExceededLimit,
      increment: mockIncrement,
      getCount: vi.fn(),
    };
  },
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/download/models/[modelVersionId]';
import { fetchDownloadCount } from '~/server/utils/download-count';
import { getTrustedClientIp } from '~/server/utils/client-ip';
import { dbMock } from '~/__tests__/mocks/db.mock';
// The handler reads the blocklist from the REPLICA only (`dbRead.keyValue.findUnique` in
// the route). The old fixture aliased dbRead and dbWrite to one spy, so a read routed to
// the primary would have satisfied it silently; binding dbRead alone makes that
// distinguishable.
const mockFindUnique = dbMock.dbRead.keyValue.findUnique;

function run(headers: Record<string, string>, remoteAddress?: string) {
  const req = {
    method: 'GET',
    query: { modelVersionId: '123' },
    headers: { 'user-agent': 'test', ...headers },
    socket: remoteAddress !== undefined ? { remoteAddress } : undefined,
  } as unknown as NextApiRequest;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;

  return { promise: handler(req, res), res };
}

/** The userKey the download quota was charged against on the last request. */
function chargedKey(): string {
  const calls = mockHasExceededLimit.mock.calls;
  return calls[calls.length - 1][0] as string;
}

/** The full query text ClickHouse was asked to run on the last call. */
function lastQuery(): string {
  const calls = mockChQuery.mock.calls;
  return calls[calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue(null);
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockChQuery.mockResolvedValue([{ count: 0 }]);
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: 'https://example.invalid/model.safetensors',
    metadata: {},
    isDownloadable: true,
    published: true,
    modelId: 1,
    modelVersionId: 123,
    fileId: 9,
    nsfw: false,
    inEarlyAccess: false,
  });
});

describe('download quota — the limiter is wired to the real counter', () => {
  it('CONTROL: the route built its limiter, so the captured options are a real observation', () => {
    // Without this, every assertion below would pass just as well against an
    // empty object that the route never populated.
    expect(
      Object.keys(limiterOptions).length,
      'createLimiter was never called — the capture is wired to nothing'
    ).toBeGreaterThan(0);
    expect(limiterOptions).toHaveProperty('counterKey');
    expect(limiterOptions).toHaveProperty('limitKey');
  });

  it('the route hands its limiter the real fetchDownloadCount', () => {
    expect(limiterOptions.fetchCount, 'the route passed no fetchCount at all').toBeTypeOf(
      'function'
    );
    expect(
      limiterOptions.fetchCount,
      'the limiter is counting with something other than fetchDownloadCount, so the quota is ' +
        'reading a number this endpoint never computes — a counter that cannot trip looks ' +
        'identical to a caller under the limit'
    ).toBe(fetchDownloadCount);
  });

  it('BEHAVIOUR: the wired fetchCount queries, rather than answering a constant', async () => {
    // The identity check above is structural and would survive a wrapper that
    // discards its argument. This drives the captured function end to end.
    mockChQuery.mockResolvedValue([{ count: 11 }]);
    const fetchCount = limiterOptions.fetchCount as (key: string) => Promise<number>;

    await expect(fetchCount('4242')).resolves.toBe(11);
    expect(mockChQuery, 'the wired fetchCount never reached ClickHouse').toHaveBeenCalledTimes(1);
    expect(lastQuery()).toContain('FROM modelVersionEvents');
    expect(lastQuery()).toContain('AND userId = 4242');
  });

  it('BEHAVIOUR: the wired fetchCount still refuses a key of neither shape', async () => {
    // The validation is a property of the function that was wired in. A stub
    // standing in for it would accept anything.
    const fetchCount = limiterOptions.fetchCount as (key: string) => Promise<number>;
    await expect(fetchCount("1.2.3.4' OR '1'='1")).rejects.toThrow(
      /rate-limit key is neither a user id nor an IP address/
    );
    expect(mockChQuery).not.toHaveBeenCalled();
  });
});

describe('download quota — the lookup key is the normalized derived address', () => {
  const RAW_PEER = '  ::ffff:203.0.113.7  ';
  const FOLDED = '203.0.113.7';

  it('an anonymous caller is charged the folded, trimmed address', async () => {
    const { promise } = run({}, RAW_PEER);
    await promise;

    // Positive control on the derivation itself, so the equality below is not
    // two wrongs agreeing.
    const derived = getTrustedClientIp({ headers: {}, socket: { remoteAddress: RAW_PEER } });
    expect(derived).toBe(FOLDED);

    // THE RELATIONSHIP: the quota key IS the derived address, not the raw text.
    expect(chargedKey()).toBe(derived);
    expect(chargedKey()).toBe(FOLDED);
    expect(chargedKey()).not.toBe(RAW_PEER);
    expect(chargedKey()).not.toBe(RAW_PEER.trim());
    // …and the same value is what the download is charged to on the way out.
    expect(mockIncrement).toHaveBeenCalledWith(FOLDED);
  });

  it('the edge-attested address is normalized on the same terms', async () => {
    const { promise } = run({ 'cf-ray': '8a1b2c3d4e5f6789-IAD', 'cf-connecting-ip': FOLDED });
    await promise;
    expect(chargedKey()).toBe(FOLDED);
  });

  it('an unresolvable address is not charged to a quota bucket at all', async () => {
    // getTrustedClientIp returns null, so there is no anonymous key: the route
    // refuses rather than inventing a shared one.
    const { promise, res } = run({});
    await promise;
    expect(mockHasExceededLimit).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('CONSEQUENCE: two spellings of one address are two different lookups', async () => {
    // The lookup is LITERAL: the key text becomes the filter text, so two keys
    // that differ at all are two different queries and one of them matches
    // nothing. That is what makes the key's provenance load-bearing, and it is
    // pinned here so a change to how the key is derived has something to trip
    // over.
    //
    // ⚠️ This is NOT the cause of the read/write divergence, and reading it as
    // such is the mistake the `download-count.ts` docblock now warns about: the
    // two sides run DIFFERENT predicates, not one predicate rendered two ways,
    // so they can name different addresses however either is spelled.
    // Normalising text on either side does not close that.
    await fetchDownloadCount(FOLDED);
    const folded = lastQuery();
    await fetchDownloadCount('::ffff:203.0.113.7');
    const mapped = lastQuery();

    expect(folded).toContain(`AND ip = '${FOLDED}'`);
    expect(mapped).toContain("AND ip = '::ffff:203.0.113.7'");
    expect(folded).not.toBe(mapped);
  });
});
