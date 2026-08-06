import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * BEHAVIOURAL guard on the address this spoke FORWARDS to the hub — the SPOKE
 * HALF of a two-sided seam.
 *
 * The relationship under test:
 *
 *   For any request, the address handed to the first-party bridge (which sends
 *   it onward as a single-value `x-forwarded-for`) is the one the SHARED
 *   attribution derivation reports for that same request — and the header is
 *   omitted entirely exactly when that derivation resolves nothing.
 *
 * 🔴 WHY A SEAM NEEDS BOTH HALVES. This file can only see what LEAVES. What the
 * far side then DERIVES from it is pinned by
 * `apps/auth/src/lib/server/auth/__tests__/request.client-ip.test.ts` in the
 * `app:auth` Vitest project — the same monorepo, a different project, so neither
 * suite loads the other's surface. A guard scoped to one side would be green
 * while the pair was broken: this side could forward a correct address that the
 * other side never reads, or the other side could read a header this side had
 * stopped sending. Both halves are asserted, and the composition is stated in
 * each file so a reader of either finds the other.
 *
 * The value matters because on the internal path the far side keys a per-IP
 * bucket on it. This suite makes no claim about that bucket's configuration —
 * only about which address arrives.
 */

const { bridgeSpy } = vi.hoisted(() => ({ bridgeSpy: vi.fn() }));

vi.mock('~/server/auth/oauth-bridge', () => ({
  HUB_BASE_URL: 'https://hub.test',
  OAUTH_BRIDGE_COOKIE: 'civ-bridge',
  BRIDGE_PROBE_COOKIE: 'civ-probe',
  resolveSelfOrigin: vi.fn(() => 'https://spoke.test'),
  clearBridgeCookie: vi.fn(() => 'civ-bridge=; Max-Age=0'),
  readBridgeProbe: vi.fn(() => undefined),
  completeFirstPartyCallback: (opts: unknown) => bridgeSpy(opts),
}));
vi.mock('@civitai/auth', () => ({ sessionCookieName: () => 'civ-token' }));
vi.mock('~/server/auth/civ-cookie', () => ({
  setSessionCookie: vi.fn(),
  postLoginMarkerCookie: vi.fn(() => 'civ-post-login=1'),
  clearLegacyCookies: vi.fn(() => []),
  hasAnyLegacyCookie: vi.fn(() => false),
  cookieDomainForHost: vi.fn(() => '.civitai.test'),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));

import handler from '../callback';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';

function reqWith(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): NextApiRequest {
  return {
    method: 'GET',
    headers: { host: 'spoke.test', ...headers },
    query: { code: 'c', state: 's' },
    cookies: { 'civ-bridge': 'stash' },
    socket: { remoteAddress },
  } as unknown as NextApiRequest;
}

function resStub(): NextApiResponse {
  const res = {
    setHeader: vi.fn(),
    getHeader: vi.fn(() => undefined),
    redirect: vi.fn(() => res),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res as unknown as NextApiResponse;
}

/** Drive the REAL handler and read the address it hands the bridge. */
async function forwardedIp(req: NextApiRequest): Promise<string | undefined> {
  await handler(req, resStub());
  const call = bridgeSpy.mock.calls[bridgeSpy.mock.calls.length - 1] as unknown as [
    { clientIp?: string }
  ];
  return call[0].clientIp;
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeSpy.mockResolvedValue({ token: 't', deviceId: 'd', returnUrl: '/' });
});

describe('auth callback: the address forwarded to the hub', () => {
  describe('harness self-checks', () => {
    it('POSITIVE CONTROL: the handler actually reaches the bridge', async () => {
      // A `clientIp` of undefined is indistinguishable from a handler that
      // returned early (no hub configured, no self origin) and never called the
      // bridge at all. Assert the call count moves off zero.
      expect(bridgeSpy.mock.calls.length).toBe(0);
      await forwardedIp(reqWith({ 'cf-connecting-ip': '203.0.113.7' }));
      expect(bridgeSpy.mock.calls.length).toBe(1);
    });

    it('POSITIVE CONTROL: the harness can observe two DIFFERENT addresses', async () => {
      const a = await forwardedIp(reqWith({ 'cf-connecting-ip': '203.0.113.7' }));
      const b = await forwardedIp(reqWith({ 'cf-connecting-ip': '198.51.100.4' }));
      expect(a).toBe('203.0.113.7');
      expect(b).toBe('198.51.100.4');
      expect(a).not.toBe(b);
    });
  });

  describe('the forwarded address is the shared derivation, on every fixture', () => {
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
      const req = reqWith(headers, peer);
      const forwarded = await forwardedIp(req);

      // (a) the address written down in the table
      expect(forwarded).toBe(expected);
      // (b) and the shared derivation's own answer for the same request
      expect(forwarded).toBe(resolveClientIpOrNull(req) ?? undefined);
    });
  });

  describe('the falsy sentinel is preserved', () => {
    it('forwards undefined — so the bridge omits the header — when nothing resolves', async () => {
      // `first-party-bridge.ts` sets the outbound header only `if (opts.clientIp)`.
      // Forwarding the shared LABEL instead of undefined would send a non-address
      // string onward as an address, so this pins the coercion.
      const forwarded = await forwardedIp(reqWith({}));
      expect(forwarded).toBeUndefined();
      expect(forwarded).not.toBe('unknown');
    });
  });

  describe('the mutant this file exists to kill', () => {
    it('a headers-stripped request forwards a DIFFERENT address than the real one', async () => {
      const real = await forwardedIp(reqWith({ 'cf-connecting-ip': '203.0.113.7' }));
      const stripped = await forwardedIp(reqWith({}));
      expect(real).toBe('203.0.113.7');
      expect(stripped).toBeUndefined();
      expect(real).not.toBe(stripped);
    });
  });
});
