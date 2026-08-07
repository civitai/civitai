import { describe, it, expect } from 'vitest';
import type { NextApiRequest } from 'next';
import requestIp from 'request-ip';

/**
 * Unit coverage for the shared client-IP predicate.
 *
 * Deliberately imported with NO `vi.mock` of anything: the point of extracting
 * this out of `public-api-rate-limit.ts` was that keying a bucket must not drag
 * a redis client into the importer's graph. If this module ever grows a stateful
 * dependency, this file stops collecting and that is the signal.
 */

import { resolveClientIp } from '../client-ip';

const SOCKET_PEER = '10.42.0.9';

/**
 * The longest textual IP address: the fully-expanded IPv4-mapped IPv6 form,
 * `0000:0000:0000:0000:0000:ffff:255.255.255.255`. Written as a literal here
 * rather than imported from the module under test — an expectation derived from
 * the implementation it checks moves with any mutation of it.
 */
const MAX_TEXTUAL_ADDRESS_LENGTH = 45;

function reqWith(headers: Record<string, string | string[]>): NextApiRequest {
  return { headers, socket: { remoteAddress: SOCKET_PEER } } as unknown as NextApiRequest;
}

describe('resolveClientIp', () => {
  it('prefers the edge-stamped CF-Connecting-IP over every other address header', () => {
    const ip = resolveClientIp(
      reqWith({
        'cf-connecting-ip': '203.0.113.7',
        'x-client-ip': '198.51.100.1',
        'x-forwarded-for': '198.51.100.2',
        'x-real-ip': '198.51.100.3',
        'true-client-ip': '198.51.100.4',
      })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('is unchanged when the non-edge address headers are rotated', () => {
    const headersFor = (v: string) => ({
      'cf-connecting-ip': '203.0.113.7',
      'x-client-ip': v,
      'x-forwarded-for': v,
      'x-real-ip': v,
    });
    const a = resolveClientIp(reqWith(headersFor('198.51.100.1')));
    const b = resolveClientIp(reqWith(headersFor('192.0.2.55')));
    expect(a).toBe(b);
    expect(a).toBe('203.0.113.7');
  });

  it('POSITIVE CONTROL: a different CF-Connecting-IP does change the result', () => {
    // Without this, the invariance assertion above would also be satisfied by a
    // function that returned a constant.
    expect(resolveClientIp(reqWith({ 'cf-connecting-ip': '203.0.113.7' }))).not.toBe(
      resolveClientIp(reqWith({ 'cf-connecting-ip': '203.0.113.8' }))
    );
  });

  it('takes the first element when cf-connecting-ip is an array + trims whitespace', () => {
    expect(resolveClientIp(reqWith({ 'cf-connecting-ip': [' 203.0.113.9 ', '5.5.5.5'] }))).toBe(
      '203.0.113.9'
    );
  });

  it('ignores an empty / whitespace-only CF header and falls through', () => {
    expect(
      resolveClientIp(reqWith({ 'cf-connecting-ip': '   ', 'x-forwarded-for': '198.51.100.1' }))
    ).toBe('198.51.100.1');
  });

  it('falls back to the library resolver for non-CF / local requests', () => {
    expect(resolveClientIp(reqWith({ 'x-forwarded-for': '198.51.100.1' }))).toBe('198.51.100.1');
    // Nothing usable in headers at all → the socket peer, never an empty string.
    expect(resolveClientIp(reqWith({}))).toBe(SOCKET_PEER);
  });

  describe('the unresolvable-caller label', () => {
    /**
     * `'unknown'` is not decoration: it is the SHARED bucket every caller with
     * no resolvable address lands in, so its value is load-bearing and a change
     * to it silently repartitions that bucket. Pinned as a LITERAL rather than
     * against a constant imported from the module — asserting a value against
     * the implementation that produces it moves with any mutation of it and so
     * proves nothing.
     *
     * MICRO-CHANGE, recorded because it was previously unasserted: under the old
     * `ctx.ip` derivation the unresolvable label was `''` (createContext's
     * `requestIp.getClientIp(req) ?? ''`); it is now `'unknown'`. Behaviourally
     * equivalent — one fixed shared bucket either way, and neither is a valid
     * address so neither can collide with a real client — but it IS a different
     * string, so the field those callers write to moves once at deploy.
     */
    // No headers AND no socket peer, so `request-ip` has nothing to return.
    const unresolvable = () => ({ headers: {}, socket: {} } as unknown as NextApiRequest);

    it('is the literal "unknown" when nothing resolves', () => {
      expect(resolveClientIp(unresolvable())).toBe('unknown');
    });

    it('POSITIVE CONTROL: the fixture really does defeat the library resolver', () => {
      // Otherwise the assertion above could pass because the socket peer merely
      // happened to be absent from THIS fixture for some unrelated reason.
      expect(requestIp.getClientIp(unresolvable())).toBeNull();
    });

    it('is NOT the empty string the old ctx.ip derivation used', () => {
      // Pins the direction of the micro-change above, so a "restore the old
      // value" edit has to be deliberate rather than incidental.
      expect(resolveClientIp(unresolvable())).not.toBe('');
    });
  });

  describe('CF header validation', () => {
    /**
     * The CF branch is validated, so the returned value is bounded to the
     * address grammar. This is what stops a caller-supplied string being used
     * verbatim as a key — see the module doc. Each case asserts the FALLTHROUGH
     * target too, not merely "not the malformed value", so a mutation that
     * returned a constant or an empty string cannot satisfy it.
     */
    const MALFORMED = [
      ['a bare integer that is also a plausible user id', '42'],
      ['an over-long octet', '999.1.1.1'],
      ['too many octets', '1.2.3.4.5'],
      ['an arbitrary token', 'notanip'],
      ['a redis-field-shaped string', 'user:42'],
    ] as const;

    it.each(MALFORMED)('ignores %s in cf-connecting-ip and falls through', (_label, value) => {
      expect(
        resolveClientIp(reqWith({ 'cf-connecting-ip': value, 'x-forwarded-for': '198.51.100.1' })),
        `a malformed cf-connecting-ip (${JSON.stringify(value)}) must not be returned verbatim`
      ).toBe('198.51.100.1');
    });

    /**
     * A COMPETING non-edge header is mandatory in the fixtures below, and the
     * reason is worth stating: `request-ip` ALSO consults `cf-connecting-ip`
     * (gated by its own `is.ip()`), and it does so AFTER `x-client-ip`. So a
     * fixture carrying ONLY `cf-connecting-ip` cannot tell "the CF branch
     * accepted this address" from "the CF branch rejected it and the fallback
     * happened to recover the same value" — the two paths return an identical
     * string and the assertion passes either way.
     *
     * Measured, not assumed: a mutant narrowing the validator to IPv4
     * (`isIP(x) === 4`) SURVIVED the single-header version of these tests, and
     * dies against the version below. `RESCUER` is chosen so the fallback's
     * answer is visibly different from the CF branch's.
     */
    const RESCUER = '198.51.100.77';
    const withRescuer = (cf: string) => reqWith({ 'cf-connecting-ip': cf, 'x-client-ip': RESCUER });

    it.each(['2400:cb00:2049:1::a29f:1804', '2001:db8::1', '::ffff:1.2.3.4'])(
      'accepts the IPv6 address %s on the CF branch itself',
      (v) => {
        // Load-bearing: if the validator rejected IPv6, every IPv6 client in
        // production would silently drop to the fallback branch. That is a live
        // traffic class, not an edge case.
        expect(
          resolveClientIp(withRescuer(v)),
          `IPv6 must be accepted by the CF branch — falling through would have yielded ${RESCUER}`
        ).toBe(v);
      }
    );

    it('still returns a well-formed IPv4 CF header unchanged', () => {
      // Negative control for the validation: it must reject malformed input
      // WITHOUT also rejecting the ordinary production case.
      expect(resolveClientIp(withRescuer('203.0.113.7'))).toBe('203.0.113.7');
    });

    /**
     * ZONE IDENTIFIERS — the bound the two branches must agree on.
     *
     * `net.isIP` accepts a zone-scoped IPv6 address (`fe80::1%eth0`) and places
     * no bound on the zone part's length or contents, so `isIP` ALONE does not
     * bound this function's return value. `request-ip`'s `is.ip()` rejects the
     * same values, so a validator resting on `isIP` alone lets the two branches
     * of this function disagree about what counts as an address — and the value
     * a caller can put through the accepting branch is then arbitrary in both
     * length and content, which the callers keying on it rely on it not being.
     *
     * Measured across both families, the zone suffix is the ENTIRE disagreement
     * between the two validators: every value they score differently contains a
     * `%`. These cases pin that, in content and in length, with a control below
     * proving the rejection is the zone suffix and not IPv6 link-local as such.
     */
    describe('zone-scoped addresses are not a bound', () => {
      it('rejects a zone-scoped IPv6 address and falls through', () => {
        expect(
          resolveClientIp(withRescuer('fe80::1%eth0')),
          'a zone-scoped address must not be returned verbatim'
        ).toBe(RESCUER);
      });

      it('rejects an unbounded zone id rather than passing it into the key space', () => {
        const overlong = `fe80::1%${'a'.repeat(4096)}`;
        const got = resolveClientIp(withRescuer(overlong));
        expect(got, 'an arbitrarily long zone id must not be returned verbatim').toBe(RESCUER);
        // Asserted independently of the fallthrough target: whatever this
        // function returns is bounded to the address grammar's own maximum, so
        // no caller-supplied length reaches a key.
        expect(got.length).toBeLessThanOrEqual(MAX_TEXTUAL_ADDRESS_LENGTH);
      });

      it('NEGATIVE CONTROL: the same address WITHOUT a zone is still accepted', () => {
        // Without this, a validator that simply rejected IPv6 link-local — or
        // rejected more than it should — would satisfy the two cases above.
        expect(
          resolveClientIp(withRescuer('fe80::1')),
          'rejecting the zone suffix must not also reject the bare address'
        ).toBe('fe80::1');
      });

      it('NEGATIVE CONTROL: the longest legal address is accepted at the bound', () => {
        // The length bound must sit at the grammar's maximum, not below it: a
        // bound that clipped a legal address would silently drop those clients
        // to the fallback branch.
        const longest = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
        expect(longest.length).toBe(MAX_TEXTUAL_ADDRESS_LENGTH);
        expect(resolveClientIp(withRescuer(longest))).toBe(longest);
      });

      it('POSITIVE CONTROL: the fallback resolver rejects these too, so the branches agree', () => {
        // The claim this file makes is agreement between the two branches, so
        // the fallback's own verdict is asserted rather than assumed. If
        // `request-ip` ever started accepting zone ids this control goes red and
        // the agreement claim above has to be re-derived.
        expect(requestIp.getClientIp(reqWith({ 'cf-connecting-ip': 'fe80::1%eth0' }))).not.toBe(
          'fe80::1%eth0'
        );
        expect(requestIp.getClientIp(reqWith({ 'cf-connecting-ip': 'fe80::1' }))).toBe('fe80::1');
      });
    });
  });
});
