import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * BEHAVIOURAL guard on the address that reaches the anonymous search-actor hash.
 *
 * The relationship under test, stated as a property so it survives a refactor of
 * how the value is obtained:
 *
 *   For any request, the actor label `runImageSearch` hands to the search layer
 *   is the one `buildSearchActor` produces from the SHARED attribution
 *   derivation's answer for that same request.
 *
 * WHY THIS EXISTS. The structural ledger
 * (`src/server/utils/__tests__/client-ip-ledger.test.ts`) is a source-text check:
 * it sees that this module imports the shared predicate and calls it, not which
 * value reaches the hash. A mutant that keeps BOTH the import and the call but
 * derives from the wrong request object — the right structure carrying the wrong
 * value — is invisible to it, and was measured surviving the whole targeted
 * battery before this file existed. That mutant is the one this file is built to
 * kill, and it is killed by the equality below rather than by any spelling.
 *
 * 🔴 BOTH SIDES ARE ASSERTED, for the reason the tracker suite states: a literal
 * alone drifts with the fixture, while a predicate-only comparison passes if BOTH
 * sides collapse to the same constant. Each fixture therefore carries an
 * independently written expected address, AND the property is checked against the
 * predicate's own answer.
 */

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: vi.fn(() => ({ canViewNsfw: true, datapacketRead: false })),
  buildFliptContext: vi.fn(() => ({})),
}));
// 'off' keeps `useBitdex` false so the call lands on the feed-search branch.
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { BITDEX_IMAGE_SEARCH: 'bitdex-image-search' },
  getFliptVariant: vi.fn(async () => 'off'),
}));
vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: vi.fn(() => 'https://edge/x') }));

const feedSearch = vi.fn(async () => ({ items: [], nextCursor: undefined }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getImagesFromFeedSearch: (...args: unknown[]) => feedSearch(...(args as [])),
}));

import { runImageSearch } from '../image-search.service';
import { buildSearchActor } from '~/server/meilisearch/client';
import { UNRESOLVED_CLIENT_IP, resolveClientIpOrNull } from '~/server/utils/client-ip';

const UA = 'probe-agent/1.0';

function reqWith(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): NextApiRequest {
  return {
    headers: { 'user-agent': UA, ...headers },
    socket: { remoteAddress },
  } as unknown as NextApiRequest;
}

/** Drive the REAL service and read the actor off the call it makes. */
async function actorFor(req: NextApiRequest): Promise<string> {
  await runImageSearch(
    { limit: 1, data: {} } as never,
    { browsingLevel: 1, user: undefined, req } as never
  );
  const call = feedSearch.mock.calls[feedSearch.mock.calls.length - 1] as unknown as [
    { actor: string }
  ];
  return call[0].actor;
}

/**
 * Fixtures span the cases where one derivation can differ from another, and are
 * shared by the derivation block and the sibling-agreement block below.
 */
const FIXTURES: ReadonlyArray<
  readonly [string, Record<string, string | string[]>, string | undefined, string | null]
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
  ['a request with nothing resolvable at all', {}, undefined, null],
];

describe('runImageSearch: the address behind the search-actor label', () => {
  beforeEach(() => {
    feedSearch.mockClear();
    feedSearch.mockResolvedValue({ items: [], nextCursor: undefined });
  });
  afterEach(() => vi.clearAllMocks());

  describe('harness self-checks', () => {
    it('POSITIVE CONTROL: the harness observes the search call actually being made', async () => {
      // A zero-call run would make every assertion below vacuous — `actorFor`
      // would throw, but a harness wired to nothing is exactly the failure that
      // reads as "no output". Assert the count moves off zero.
      expect(feedSearch.mock.calls.length).toBe(0);
      await actorFor(reqWith({ 'cf-connecting-ip': '203.0.113.7' }));
      expect(feedSearch.mock.calls.length).toBeGreaterThan(0);
    });

    it('POSITIVE CONTROL: the harness can resolve two DIFFERENT actors', async () => {
      // Proves the oracle can observe a difference at all. Without it, every
      // agreement assertion below would also pass against a service that emitted
      // one constant actor for every request.
      const a = await actorFor(reqWith({ 'cf-connecting-ip': '203.0.113.7' }));
      const b = await actorFor(reqWith({ 'cf-connecting-ip': '198.51.100.4' }));
      expect(a).not.toBe(b);
    });
  });

  describe('the actor is built from the shared derivation, on every fixture', () => {
    it.each(FIXTURES)('%s', async (_label, headers, peer, expectedIp) => {
      const req = reqWith(headers, peer);

      // (a) the derivation resolves to the address written down in the table
      expect(resolveClientIpOrNull(req)).toBe(expectedIp);

      // (b) and the actor on the wire is the hash of exactly that address —
      //     the property, which holds whatever the derivation is spelled as.
      const onWire = await actorFor(req);
      expect(onWire).toBe(buildSearchActor({ ip: expectedIp, userAgent: UA }));
      expect(onWire).toBe(buildSearchActor({ ip: resolveClientIpOrNull(req), userAgent: UA }));
    });
  });

  describe('agreement with the two ctx.ip-fed sibling call sites', () => {
    /**
     * `ctx.ip` is `resolveClientIpOrNull(req) ?? ''` and feeds the two
     * `buildSearchActor` calls in `image.controller.ts`. One caller must not be
     * hashed to two different actors depending on which entry point served the
     * request, so this pins what that agreement does and does NOT depend on.
     */
    it("agrees with the ctx.ip form on every fixture — the `?? ''` sentinel is inert", async () => {
      for (const [, headers, peer] of FIXTURES) {
        const req = reqWith(headers, peer);
        const ctxIpForm = buildSearchActor({
          ip: resolveClientIpOrNull(req) ?? '',
          userAgent: UA,
        });
        expect(await actorFor(req)).toBe(ctxIpForm);
      }
    });

    it('but the shared LABEL is NOT interchangeable — it would break that agreement', () => {
      // Why this site takes `resolveClientIpOrNull` and not `resolveClientIp`.
      // `null`/`''` fold to one hash input; `'unknown'` hashes as itself.
      expect(buildSearchActor({ ip: null, userAgent: UA })).toBe(
        buildSearchActor({ ip: '', userAgent: UA })
      );
      expect(buildSearchActor({ ip: UNRESOLVED_CLIENT_IP, userAgent: UA })).not.toBe(
        buildSearchActor({ ip: '', userAgent: UA })
      );
    });
  });

  describe('the mutant this file exists to kill', () => {
    it('a headers-stripped request produces a DIFFERENT actor than the real one', async () => {
      // The surviving mutant's shape: right import, right call, wrong request.
      // If deriving from a stripped request were indistinguishable from deriving
      // from the real one, the guard above could not detect it — so pin that the
      // two are observably different before relying on the equality.
      const real = reqWith({ 'cf-connecting-ip': '203.0.113.7' });
      const stripped = reqWith({});
      expect(await actorFor(real)).not.toBe(await actorFor(stripped));
    });

    it('a signed-in caller is labelled by user id, not by address', async () => {
      // The `if (userId) return` branch of buildSearchActor. Pinned so a change
      // that routed every caller through the hash would be visible here.
      await runImageSearch(
        { limit: 1, data: {} } as never,
        {
          browsingLevel: 1,
          user: { id: 42 },
          req: reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
        } as never
      );
      const call = feedSearch.mock.calls[feedSearch.mock.calls.length - 1] as unknown as [
        { actor: string }
      ];
      expect(call[0].actor).toBe('user:42');
    });
  });
});
