import { describe, expect, it } from 'vitest';
import { getClientIp } from '../request';

/**
 * BEHAVIOURAL guard on the address the HUB derives — the HUB HALF of a two-sided
 * seam whose other half lives in the main app's Vitest project.
 *
 * The relationship under test:
 *
 *   On the INTERNAL path — a server-to-server call carrying no edge value — the
 *   address this hub derives is exactly the one the spoke forwarded as the
 *   leftmost `x-forwarded-for` hop. That derived value is what
 *   `api/auth/oauth/session/+server.ts` keys its per-IP bucket on.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL. The spoke's call site used to carry a comment
 * asserting that the far side of this forward "cannot be observed, reproduced or
 * tested from this repo — the far side is not in this tree". That was FALSE in
 * both clauses: `apps/auth` is in this monorepo and has its own Vitest project
 * (`apps/auth/vitest.config.ts`, adopted by the root config's `apps/*` glob), so
 * the far side is both in the tree and directly testable. This file is the
 * demonstration; it is cheap, and its absence was the whole basis for leaving
 * one derivation site unconsolidated.
 *
 * The spoke half — that what is forwarded IS the shared attribution
 * derivation's answer — is pinned by
 * `src/pages/api/auth/__tests__/callback.client-ip.test.ts`. Neither half covers
 * the seam alone: this one would stay green if the spoke stopped sending the
 * header, and that one would stay green if the hub stopped reading it.
 */

const req = (headers: Record<string, string>) => new Request('https://hub.test/', { headers });

describe('hub getClientIp: which address the far side derives', () => {
  describe('harness self-checks', () => {
    it('POSITIVE CONTROL: the derivation can return two DIFFERENT addresses', () => {
      // Guards against every assertion below passing against a function that
      // returned one constant.
      expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
      expect(getClientIp(req({ 'x-forwarded-for': '198.51.100.4' }))).toBe('198.51.100.4');
    });
  });

  describe('the internal path — no edge value present', () => {
    it('derives exactly the single address the spoke forwarded', () => {
      // The shape the bridge actually sends: `x-forwarded-for` set to one value.
      expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    });

    it('takes the LEFTMOST hop when the header carries a chain', () => {
      expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    });

    it('returns null when the spoke forwarded nothing', () => {
      // The bridge omits the header entirely on an unresolved address, so this
      // is the state the spoke's `undefined` sentinel produces here. Null means
      // the session endpoint degrades its bucket key rather than 500ing.
      expect(getClientIp(req({}))).toBeNull();
    });
  });

  describe('the public path — an edge value is present', () => {
    it('PREFERS its own edge value over the forwarded one', () => {
      // This is why the forwarded address is shadowed on the public path: the
      // hub does not consult it when it has an edge-stamped value of its own.
      const r = req({ 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' });
      expect(getClientIp(r)).toBe('198.51.100.4');
      expect(getClientIp(r)).not.toBe('203.0.113.7');
    });
  });

  describe('the seam, composed', () => {
    it('an address forwarded by the spoke survives the hop unchanged', () => {
      // The end-to-end property, written as the composition it is: whatever the
      // spoke resolved and sent is what the hub derives back out on the internal
      // path. The spoke's half of this equality is asserted in the main project.
      for (const forwarded of ['203.0.113.7', '198.51.100.4', '2001:db8::1']) {
        expect(getClientIp(req({ 'x-forwarded-for': forwarded }))).toBe(forwarded);
      }
    });
  });
});
