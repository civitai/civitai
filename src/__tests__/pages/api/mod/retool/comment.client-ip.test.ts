import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BEHAVIOURAL guard on the address recorded in the moderation audit trail.
 *
 * The relationship under test, stated as a property so it survives a refactor of
 * how the value is obtained:
 *
 *   For any request, the address `removeAsTos` puts on the `actor` it hands to
 *   the comment services is the one the SHARED attribution derivation reports
 *   for that same request — and `undefined` exactly when that derivation
 *   resolves nothing.
 *
 * WHY THIS EXISTS. The structural ledger
 * (`src/server/utils/__tests__/client-ip-ledger.test.ts`) is a source-text check:
 * it sees this module's import and its call, not which value reaches `actor.ip`.
 * A mutant that keeps BOTH the import and the call but derives from a
 * headers-stripped request — the right structure carrying the wrong value — is
 * invisible to it. This file drives the REAL endpoint through its REAL wrapper
 * and reads the address off the call the handler actually makes.
 *
 * 🔴 BOTH SIDES ARE ASSERTED: an independently written expected literal per
 * fixture (which a predicate-only check would not give, since both sides could
 * collapse to one constant) AND the property against the predicate's own answer.
 *
 * 🔴 WHY THIS FILE IS HERE AND NOT NEXT TO THE HANDLER. Every `.ts`/`.tsx` under
 * `src/pages/**` is enumerated by Next as a route — `isPageFile` is a bare
 * extension test with no test-file exclusion — so a suite co-located in
 * `src/pages/api/mod/retool/__tests__/` becomes the API route
 * `/api/mod/retool/__tests__/comment.client-ip.test`, and `next build` then
 * asserts it satisfies `ApiRouteConfig`, which requires a `default` export. It has
 * none, so the PRODUCTION BUILD fails while every correctness gate stays green
 * (see the guard in `src/__tests__/pages/no-test-files-in-pages-tree.test.ts` for
 * the full mechanism). `src/__tests__/pages/api/**` mirrors the route tree without
 * being inside it, which is the convention the sibling API suites already follow.
 */

const { mockGetSession, mockRetoolAudit } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRetoolAudit: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockRetoolAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => res.status(500).json({ error: 'error', message: (e as Error).message }),
}));

// The capture points: the two services the handler hands its `actor` to.
const setTos = vi.fn(async () => ({ count: 1, notified: 0, rewardedReports: 0 }));
vi.mock('~/server/services/comment.service', () => ({
  bulkDeleteComments: vi.fn(async () => ({ count: 0 })),
  bulkSetCommentTosViolation: (...a: unknown[]) => setTos(...(a as [])),
}));
vi.mock('~/server/services/commentsv2.service', () => ({
  bulkDeleteCommentsV2: vi.fn(async () => ({ count: 0 })),
  bulkSetCommentV2TosViolation: vi.fn(async () => ({
    count: 0,
    notified: 0,
    rewardedReports: 0,
  })),
}));

import handler from '~/pages/api/mod/retool/comment';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockRedis = redisMock.sysRedis;
redisMock.sysRedis.multi.mockImplementation(() => ({
  set: vi.fn().mockReturnThis(),
  incr: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(['OK', 1]),
}));
redisMock.sysRedis.ttl.mockResolvedValue(60);

function createMocks(headers: Record<string, string | string[]>, remoteAddress?: string) {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer tok', ...headers },
    body: { action: 'removeAsTos', commentIds: [1] },
    query: {},
    socket: { remoteAddress },
  } as unknown as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  } as unknown as Parameters<typeof handler>[1] & {
    _status: () => number;
    _json: () => unknown;
  };
  return { req, res };
}

/** Drive the REAL endpoint and read the recorded address off the service call. */
async function recordedIp(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): Promise<string | undefined> {
  const { req, res } = createMocks(headers, remoteAddress);
  await handler(req, res);
  // Surface a wrapper rejection rather than letting it read as "no address".
  expect((res as unknown as { _status: () => number })._status()).toBe(200);
  const call = setTos.mock.calls[setTos.mock.calls.length - 1] as unknown as [
    { actor: { id: number; ip?: string } }
  ];
  return call[0].actor.ip;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: 7, isModerator: true, bannedAt: null, permissions: [] },
  });
  setTos.mockResolvedValue({ count: 1, notified: 0, rewardedReports: 0 });
});

describe('retool removeAsTos: the address recorded in the audit trail', () => {
  describe('harness self-checks', () => {
    it('POSITIVE CONTROL: the handler actually reaches the service', async () => {
      // Without this, every assertion below is indistinguishable from a harness
      // whose request was rejected by the wrapper before the handler ran — a
      // reassuring `undefined` that means "nothing happened", not "no address".
      expect(setTos.mock.calls.length).toBe(0);
      await recordedIp({ 'cf-connecting-ip': '203.0.113.7' });
      expect(setTos.mock.calls.length).toBe(1);
    });

    it('POSITIVE CONTROL: the harness can observe two DIFFERENT addresses', async () => {
      const a = await recordedIp({ 'cf-connecting-ip': '203.0.113.7' });
      const b = await recordedIp({ 'cf-connecting-ip': '198.51.100.4' });
      expect(a).toBe('203.0.113.7');
      expect(b).toBe('198.51.100.4');
      expect(a).not.toBe(b);
    });
  });

  describe('the recorded address is the shared derivation, on every fixture', () => {
    const FIXTURES: ReadonlyArray<
      readonly [string, Record<string, string | string[]>, string | undefined, string | undefined]
    > = [
      ['an edge-stamped request', { 'cf-connecting-ip': '203.0.113.7' }, undefined, '203.0.113.7'],
      [
        'an edge-stamped request that also carries a competing address',
        { 'cf-connecting-ip': '203.0.113.7', 'x-client-ip': '198.51.100.4' },
        undefined,
        '203.0.113.7',
      ],
      [
        'a request whose edge value is not an address, falling through',
        { 'cf-connecting-ip': 'notanip', 'x-client-ip': '198.51.100.4' },
        undefined,
        '198.51.100.4',
      ],
      ['a request with only a transport peer', {}, '10.42.0.9', '10.42.0.9'],
    ];

    it.each(FIXTURES)('%s', async (_label, headers, peer, expected) => {
      const { req } = createMocks(headers, peer);
      const recorded = await recordedIp(headers, peer);

      // (a) the value written down in the table
      expect(recorded).toBe(expected);
      // (b) and the shared derivation's own answer for the same request
      expect(recorded).toBe(resolveClientIpOrNull(req as never) ?? undefined);
    });
  });

  describe('the undefined sentinel', () => {
    it('records undefined — not the shared label — when nothing resolves', async () => {
      // The sentinel this site has always used. A change to the shared label
      // ('unknown') leaking through here would be a silent value change in the
      // audit trail, and is what this pins.
      const recorded = await recordedIp({});
      expect(recorded).toBeUndefined();
      expect(recorded).not.toBe('unknown');
    });
  });

  describe('the mutant this file exists to kill', () => {
    it('a headers-stripped request records a DIFFERENT address than the real one', async () => {
      // The surviving mutant's shape: right import, right call, wrong request.
      // Pin that the two are observably different, so the equality above is
      // known to be able to detect it.
      const real = await recordedIp({ 'cf-connecting-ip': '203.0.113.7' });
      const stripped = await recordedIp({});
      expect(real).toBe('203.0.113.7');
      expect(stripped).toBeUndefined();
      expect(real).not.toBe(stripped);
    });
  });
});
