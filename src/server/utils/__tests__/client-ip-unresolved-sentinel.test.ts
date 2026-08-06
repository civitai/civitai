import { describe, it, expect } from 'vitest';
import type { NextApiRequest } from 'next';

import { UNRESOLVED_CLIENT_IP, resolveClientIp, resolveClientIpOrNull } from '../client-ip';

/**
 * The unresolvable-caller sentinel, and the adapter that translates it.
 *
 * WHY AN ADAPTER EXISTS AT ALL. `resolveClientIp` is total: it always answers,
 * and answers `UNRESOLVED_CLIENT_IP` when nothing resolves. That is right for a
 * surface whose own "no address" value is already that label — the ClickHouse
 * tracker initialises `actor.ip` to exactly it — and wrong for a surface built
 * around a FALSY sentinel, because downstream code distinguishes the two:
 *
 *   - `base.reward.ts` folds `''` (and `::1`) to `undefined` before an address
 *     can reach a buzz-transaction idempotency key. The label is not in that
 *     list, so routing it there would change a key that guards real money.
 *   - `buildSearchActor` hashes `ip ?? ''`, and its call sites must agree with
 *     each other or one caller is hashed to two different actor labels.
 *
 * So the consolidation kept EACH SURFACE'S EXISTING SENTINEL and changed only
 * which address is derived when one resolves. This file pins that property —
 * it is the difference between a rewire and a behaviour change, and it is the
 * half a per-site test cannot see because each site looks locally reasonable.
 */

function reqWith(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): NextApiRequest {
  return { headers, socket: { remoteAddress } } as unknown as NextApiRequest;
}

/** A request from which no address can be derived by any route. */
function unresolvableReq(): NextApiRequest {
  return reqWith({});
}

describe('client-ip: the unresolvable sentinel and its adapter', () => {
  describe('harness self-checks', () => {
    it('POSITIVE CONTROL: the fixture builder CAN produce a resolvable request', () => {
      // Without this, every "returns the sentinel" assertion below would pass
      // against a builder that produced an unusable request every time.
      expect(resolveClientIp(reqWith({}, '203.0.113.7'))).toBe('203.0.113.7');
      expect(resolveClientIpOrNull(reqWith({}, '203.0.113.7'))).toBe('203.0.113.7');
    });

    it('NEGATIVE CONTROL: the unresolvable fixture really resolves to nothing', () => {
      expect(resolveClientIp(unresolvableReq())).toBe(UNRESOLVED_CLIENT_IP);
    });
  });

  describe('the sentinel is a value nothing else can produce', () => {
    it('is not itself a valid address, so it cannot collide with a real one', () => {
      // This is what makes `=== UNRESOLVED_CLIENT_IP` an unambiguous test for
      // "nothing resolved" rather than a string match that a caller could fake.
      // Both branches of `resolveClientIp` validate, and neither admits it.
      expect(resolveClientIp(reqWith({ 'cf-connecting-ip': UNRESOLVED_CLIENT_IP }))).toBe(
        UNRESOLVED_CLIENT_IP
      );
      // ...and that answer came from the FALLTHROUGH, not from the header being
      // accepted. Proven by giving the fallback something else to find: if the
      // header had been accepted, this would still be the label.
      expect(
        resolveClientIp(
          reqWith({ 'cf-connecting-ip': UNRESOLVED_CLIENT_IP, 'x-client-ip': '198.51.100.4' })
        )
      ).toBe('198.51.100.4');
    });

    it('is the exact literal the tracker already defaults to', () => {
      // Pinned as a literal on purpose. The tracker's `actor.ip` initialiser is
      // a separate declaration in a different file; if either moves, the
      // tracker's "no address" value stops matching the shared one and its
      // rows silently split across two spellings of the same fact.
      expect(UNRESOLVED_CLIENT_IP).toBe('unknown');
    });
  });

  describe('the adapter translates ONLY the sentinel', () => {
    it('maps the unresolvable case to null', () => {
      expect(resolveClientIpOrNull(unresolvableReq())).toBeNull();
    });

    it.each([
      ['an edge-stamped IPv4 address', { 'cf-connecting-ip': '203.0.113.7' }, '203.0.113.7'],
      ['an edge-stamped IPv6 address', { 'cf-connecting-ip': '2001:db8::1' }, '2001:db8::1'],
      ['a value recovered by the fallback', { 'x-client-ip': '198.51.100.4' }, '198.51.100.4'],
    ])('passes %s through unchanged', (_label, headers, expected) => {
      expect(resolveClientIpOrNull(reqWith(headers))).toBe(expected);
    });

    it('passes the transport peer through unchanged', () => {
      expect(resolveClientIpOrNull(reqWith({}, '10.42.0.9'))).toBe('10.42.0.9');
    });

    it('is exactly `resolveClientIp` with the sentinel nulled, on every fixture', () => {
      // The RELATIONSHIP, asserted as a property rather than case by case: the
      // adapter must never disagree with the derivation about WHICH address a
      // request has. A second opinion hidden in the adapter is the failure this
      // catches, and it would be invisible to the per-case assertions above.
      const fixtures: NextApiRequest[] = [
        unresolvableReq(),
        reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
        reqWith({ 'cf-connecting-ip': '2001:db8::1' }),
        reqWith({ 'cf-connecting-ip': 'notanip' }, '10.42.0.9'),
        reqWith({ 'cf-connecting-ip': 'fe80::1%eth0' }, '10.42.0.9'),
        reqWith({ 'x-client-ip': '198.51.100.4' }),
        reqWith({}, '10.42.0.9'),
        reqWith({ 'cf-connecting-ip': ['203.0.113.9', '203.0.113.10'] }),
      ];

      // POSITIVE CONTROL on the fixture set itself: it must contain both a
      // resolvable and an unresolvable case, or the property below is trivial.
      const total = fixtures.map((r) => resolveClientIp(r));
      expect(total.filter((v) => v === UNRESOLVED_CLIENT_IP).length).toBeGreaterThanOrEqual(1);
      expect(total.filter((v) => v !== UNRESOLVED_CLIENT_IP).length).toBeGreaterThanOrEqual(6);

      for (const req of fixtures) {
        const label = resolveClientIp(req);
        const nullable = resolveClientIpOrNull(req);
        expect(nullable).toBe(label === UNRESOLVED_CLIENT_IP ? null : label);
      }
    });
  });

  describe('the sentinels the call sites rebuild from null are the ones they had', () => {
    /**
     * Each site re-applies its OWN sentinel on top of the adapter. Those
     * expressions are one token long and look too small to test — which is
     * exactly why they are pinned: getting one wrong changes a value that is
     * carried into a keyspace, and nothing at the site would report it.
     */
    it("ctx.ip's empty-string sentinel survives an unresolvable request", () => {
      expect(resolveClientIpOrNull(unresolvableReq()) ?? '').toBe('');
    });

    it("the audit trail's undefined sentinel survives an unresolvable request", () => {
      expect(resolveClientIpOrNull(unresolvableReq()) ?? undefined).toBeUndefined();
    });

    it('and both still carry a real address through when one resolves', () => {
      // The negative half. Without it, an adapter that returned null for
      // everything would satisfy both assertions above.
      const resolvable = reqWith({ 'cf-connecting-ip': '203.0.113.7' });
      expect(resolveClientIpOrNull(resolvable) ?? '').toBe('203.0.113.7');
      expect(resolveClientIpOrNull(resolvable) ?? undefined).toBe('203.0.113.7');
    });
  });
});
