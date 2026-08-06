import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest } from 'next';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';

/**
 * Guards the BUCKET KEY the generic tRPC `rateLimit()` middleware writes to.
 *
 * The relationship under test — stated as a property, not as a spelling, so it
 * survives any refactor of how the key is computed:
 *
 *   For an ANONYMOUS caller, the rate-limit bucket field is a function of the
 *   EDGE-STAMPED client address alone. Two requests that Cloudflare stamps with
 *   the same `cf-connecting-ip` MUST land in the same bucket no matter what
 *   other client-supplied address headers they carry; two requests the edge
 *   stamps differently MUST land in different buckets.
 *
 * Both halves are asserted on purpose. The "same bucket" half alone would pass
 * against a limiter that had collapsed every anonymous caller onto one constant
 * — a reassuring answer from a harness wired to nothing. The "different bucket"
 * half is its positive control: it proves this harness can OBSERVE a key
 * difference at all, so the invariance result means something.
 *
 * The second property, further down: the field is drawn from two namespaces —
 * user ids and client addresses — written into ONE redis hash, so those two key
 * spaces must be disjoint for every value either side can take.
 *
 * Fixture fidelity: `ctx.ip` is built here with the same expression
 * `createContext` uses (`resolveClientIpOrNull(req) ?? ''`) so the synthetic
 * context is faithful to the real one rather than to whatever value would make
 * the test convenient. 🔴 That coupling is REAL and has bitten: this fixture
 * previously open-coded the library derivation, and when createContext moved to
 * the shared predicate the fixture kept building a value production no longer
 * produces — a test drifting away from the thing it claims to model, silently
 * and while green. Which predicate each site binds is pinned by
 * `src/server/utils/__tests__/client-ip-ledger.test.ts`; if that ledger says
 * createContext binds something other than what this line calls, this comment
 * is stale again.
 *
 * Harness shape is copied from `middleware.trpc.test.ts` — intercept
 * `~/server/trpc`'s `middleware()` to capture the handler the factory passes
 * in, then invoke it directly. Note `~/env/other` MUST be mocked to a
 * production-like shape: the middleware short-circuits on `isTest`, so without
 * this mock the whole body under test never runs and every assertion here would
 * be vacuous.
 */

const { mockHSetWithTTL, mockHGet, capturedHandler } = vi.hoisted(() => {
  const captured: { handler: ((arg: unknown) => Promise<unknown>) | null } = { handler: null };
  return {
    mockHSetWithTTL: vi.fn(),
    mockHGet: vi.fn(),
    capturedHandler: captured,
  };
});

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

vi.mock('~/server/redis/client', () => ({
  redis: { packed: { hGet: mockHGet } },
  REDIS_KEYS: { TRPC: { LIMIT: { BASE: 'trpc:rate-limit' } } },
}));

vi.mock('~/server/trpc', () => ({
  middleware: (fn: (arg: unknown) => Promise<unknown>) => {
    capturedHandler.handler = fn;
    return fn;
  },
}));

// Pass-throughs for the rest of middleware.trpc's import graph — only touched by
// sibling middlewares this file never invokes.
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn(async () => ({
    hiddenImages: [],
    hiddenTags: [],
    hiddenModels: [],
    hiddenUsers: [],
  })),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(async () => undefined) }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: vi.fn(() => 'blue'),
  getRequestBoardDomainColor: vi.fn(() => 'blue'),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/env/other', () => ({
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
}));

import { rateLimit } from '../middleware.trpc';

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler.handler = null;
  mockHGet.mockResolvedValue([]);
  mockHSetWithTTL.mockResolvedValue(undefined);
});

const SOCKET_PEER = '10.42.0.9';

function reqWith(headers: Record<string, string | string[]>): NextApiRequest {
  return { headers, socket: { remoteAddress: SOCKET_PEER } } as unknown as NextApiRequest;
}

/**
 * Build the context the way `createContext` does, so `ctx.ip` carries exactly
 * the value the real anonymous request would carry.
 */
function anonCtx(headers: Record<string, string | string[]>) {
  const req = reqWith(headers);
  return { user: undefined, ip: resolveClientIpOrNull(req) ?? '', req };
}

/**
 * Drive the real middleware once and return the hash field it addressed in
 * redis. Reading the argument the limiter actually passed to `hGet` — rather
 * than re-deriving it — is what makes this a behavioural guard: it holds for any
 * implementation that ends up keying the bucket correctly.
 */
async function bucketFieldFor(ctx: Record<string, unknown>): Promise<string> {
  rateLimit({ limit: 10, period: 60 });
  const handler = capturedHandler.handler;
  if (!handler)
    throw new Error('harness broken: rateLimit() did not register a middleware handler');

  const before = mockHGet.mock.calls.length;
  await handler({
    ctx,
    input: undefined,
    path: 'test:procedure',
    next: vi.fn(async () => ({ ok: true })),
  });
  const calls = mockHGet.mock.calls;
  if (calls.length !== before + 1) {
    throw new Error(
      `harness broken: expected exactly one redis hGet for this call, saw ${
        calls.length - before
      }. ` +
        'The middleware short-circuited before computing a bucket key (check the ~/env/other mock).'
    );
  }
  return calls[calls.length - 1][1] as string;
}

const EDGE_IP = '203.0.113.7';

// EVERY non-edge address header `request-ip` consults, enumerated from the
// library's own source (`request-ip/lib/index.js`, `getClientIp`) rather than
// from its README — the README lists fewer than the code reads. The one header
// it consults that is NOT here is `cf-connecting-ip`, deliberately: that is the
// edge-stamped header this suite holds FIXED while rotating the rest.
//
// Covered as a SET rather than one representative: a derivation that handled
// some members and not others would otherwise pass, and which member is
// consulted first is a library detail this suite should not have to know. The
// enumeration is self-verifying — `is genuinely consulted by the resolver`
// below fails if a listed header is not actually read, so this list cannot
// silently drift into claiming coverage it does not have.
const NON_EDGE_ADDRESS_HEADERS = [
  'x-client-ip',
  'x-forwarded-for',
  'x-real-ip',
  'true-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'x-forwarded',
  'forwarded-for',
  'forwarded',
  'x-appengine-user-ip',
] as const;

const fill = (headers: readonly string[], value: string) =>
  Object.fromEntries(headers.map((h) => [h, value]));

describe('rateLimit bucket key — anonymous callers', () => {
  it('is INVARIANT under every non-edge address header at once', async () => {
    const a = await bucketFieldFor(
      anonCtx({ 'cf-connecting-ip': EDGE_IP, ...fill(NON_EDGE_ADDRESS_HEADERS, '198.51.100.1') })
    );
    const b = await bucketFieldFor(
      anonCtx({ 'cf-connecting-ip': EDGE_IP, ...fill(NON_EDGE_ADDRESS_HEADERS, '192.0.2.55') })
    );

    expect(
      a,
      'two anonymous requests with the same edge-stamped client IP must share one rate-limit bucket'
    ).toBe(b);
    // Pin WHICH address won AND the namespace it was written under, so this can
    // pass neither by collapsing onto a constant nor by dropping the prefix that
    // keeps addresses out of the user-id key space.
    expect(a).toBe(`ip:${EDGE_IP}`);
  });

  it('POSITIVE CONTROL: a different edge-stamped IP DOES produce a different bucket', async () => {
    const a = await bucketFieldFor(anonCtx({ 'cf-connecting-ip': EDGE_IP }));
    const b = await bucketFieldFor(anonCtx({ 'cf-connecting-ip': '203.0.113.8' }));

    expect(
      a,
      'harness must be able to observe a bucket difference — otherwise the invariance test above is vacuous'
    ).not.toBe(b);
  });

  // Per-header, so a derivation that covers most of the set but misses one member
  // still fails — the all-at-once case above cannot distinguish that.
  it.each(NON_EDGE_ADDRESS_HEADERS)('is INVARIANT under %s rotated on its own', async (header) => {
    const a = await bucketFieldFor(
      anonCtx({ 'cf-connecting-ip': EDGE_IP, [header]: '198.51.100.1' })
    );
    const b = await bucketFieldFor(
      anonCtx({ 'cf-connecting-ip': EDGE_IP, [header]: '192.0.2.55' })
    );
    expect(a, `rotating ${header} on its own must not move the anon rate-limit bucket`).toBe(b);
    expect(a).toBe(`ip:${EDGE_IP}`);
  });

  // POSITIVE CONTROL for the enumeration above. The invariance cases pass for a
  // header the resolver never reads at all — an inert name would look exactly
  // like a correctly-ignored one. Each member is therefore also shown to DRIVE
  // the bucket when the edge header is absent, which is what makes the list an
  // enumeration of the real set rather than a list of plausible spellings.
  it.each(NON_EDGE_ADDRESS_HEADERS)('%s is genuinely consulted by the resolver', async (header) => {
    const field = await bucketFieldFor(anonCtx({ [header]: '198.51.100.1' }));
    expect(
      field,
      `${header} is listed as a consulted address header but did not move the bucket off the socket peer`
    ).toBe('ip:198.51.100.1');
  });
});

describe('rateLimit bucket key — other principals', () => {
  it('authenticated callers key on the user id, ignoring every address header', async () => {
    const req = reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-client-ip': '198.51.100.1' });
    const field = await bucketFieldFor({
      user: { id: 42, isModerator: false },
      ip: resolveClientIpOrNull(req) ?? '',
      req,
    });
    // Namespaced: the id is written under `user:`, never bare, so it occupies a
    // key space disjoint from anything written into the address side.
    expect(field).toBe('user:42');
  });

  // INVARIANT GUARD, not regression coverage: the code this replaced used `??`,
  // which already handled id 0 correctly. It pins that the `!= null` test was
  // preserved rather than relaxed to a truthiness test — id 0 is a legal
  // principal, and a truthy check would silently route it to the address branch
  // and bucket that user alongside anonymous callers on the same IP.
  it('a user id of 0 keys the user bucket, not the address branch', async () => {
    const req = reqWith({ 'cf-connecting-ip': EDGE_IP });
    const field = await bucketFieldFor({
      user: { id: 0, isModerator: false },
      ip: resolveClientIpOrNull(req) ?? '',
      req,
    });
    expect(
      field,
      'id 0 is a valid principal; a truthiness test would route it to the address branch'
    ).toBe('user:0');
  });

  // INVARIANT GUARD, not regression coverage: this behaviour is unchanged by the
  // consolidation. It pins that the non-CF fallback was RETAINED, so a later
  // "tighten it to CF-only" edit has to face the dev/direct-to-origin case
  // deliberately instead of silently collapsing those callers into one bucket.
  it('non-CF requests still fall back to the library resolver rather than collapsing', async () => {
    const a = await bucketFieldFor(anonCtx({ 'x-forwarded-for': '198.51.100.1' }));
    const b = await bucketFieldFor(anonCtx({ 'x-forwarded-for': '198.51.100.2' }));
    expect(a).toBe('ip:198.51.100.1');
    expect(b).toBe('ip:198.51.100.2');
  });
});

/**
 * REGRESSION COVERAGE — the two key spaces are disjoint.
 *
 * The bucket field is drawn from two different namespaces: user ids on one side,
 * client addresses on the other. Both are written into ONE redis hash, and in a
 * hash equal strings are the same bucket. The invariant is therefore a property
 * of the key space itself: a field written from the address side must never be
 * able to equal a field written from the id side, for any value either side can
 * take.
 *
 * Asserted as that property rather than as one payload. The `authed !== anon`
 * form holds for any implementation that keeps the two spaces apart — by
 * namespacing the field, by bounding what the address side may contain, or by
 * both — so it pins the relationship and not today's spelling.
 */
describe('rateLimit bucket key — key-space separation', () => {
  const SAMPLE_USER_ID = 42;

  async function authedFieldFor(userId: number) {
    const req = reqWith({});
    return bucketFieldFor({
      user: { id: userId, isModerator: false },
      ip: resolveClientIpOrNull(req) ?? '',
      req,
    });
  }

  it('a value well-formed on both sides does not address the same bucket from either', async () => {
    // A bare integer is the overlap case: it is a legal user id, and it is a
    // string the address side can also carry. If the two spaces were shared,
    // this is the shape that would collide.
    const authed = await authedFieldFor(SAMPLE_USER_ID);
    const anon = await bucketFieldFor(anonCtx({ 'cf-connecting-ip': String(SAMPLE_USER_ID) }));

    expect(
      anon,
      'a field written from the address side must not equal a field written from the id side'
    ).not.toBe(authed);
  });

  it('POSITIVE CONTROL: the harness can observe two fields colliding', async () => {
    // Guards the assertion above against passing for the wrong reason. If the
    // harness could never produce equal fields, `not.toBe` would be satisfied by
    // construction and prove nothing. Two reads of the SAME principal must
    // collide — that is what makes the inequality above a real observation.
    const a = await authedFieldFor(SAMPLE_USER_ID);
    const b = await authedFieldFor(SAMPLE_USER_ID);
    expect(a, 'same principal must map to one stable bucket field').toBe(b);
  });

  it('separation is not bought by collapsing the address side onto a constant', async () => {
    // Disjointness is trivially satisfiable by making one side degenerate, which
    // would replace the shared key space with a single shared bucket for every
    // anonymous caller — strictly worse. The address side must still vary.
    const a = await bucketFieldFor(anonCtx({ 'cf-connecting-ip': '203.0.113.7' }));
    const b = await bucketFieldFor(anonCtx({ 'cf-connecting-ip': '203.0.113.8' }));
    expect(a).not.toBe(b);
  });
});
