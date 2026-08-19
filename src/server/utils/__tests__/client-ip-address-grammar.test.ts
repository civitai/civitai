import { describe, it, expect } from 'vitest';
import type { NextApiRequest } from 'next';

import { isIpAddress, resolveClientIp } from '../client-ip';

/**
 * THE address grammar for `client-ip.ts`, and the guard that there is only one.
 *
 * REPLACES a differential test. `client-ip.ts` used to hold two validators —
 * a private `isBareAddress` and the exported `isIpAddress` — that applied the
 * same rule and were held together by a test comparing them to each other. They
 * are now one function, so that comparison would be a function compared with
 * itself: it would pass against any mutation, including one that broke the rule
 * in both directions at once. A test that cannot fail is worse than no test,
 * because it reports coverage.
 *
 * What replaces it has teeth in two ways the comparison did not:
 *
 *  1. THE EXPECTED VERDICTS ARE WRITTEN DOWN. The old table deliberately
 *     recorded no expectation — it only asserted that two implementations
 *     agreed, which is exactly the assertion that survives when both move
 *     together. Every row below carries a literal `true`/`false` derived from
 *     the ADDRESS GRAMMAR, not from running the code. Read the row, not the
 *     implementation, when one of these fails.
 *
 *  2. IT STILL PINS A RELATIONSHIP. The point of the consolidation is that ONE
 *     place decides what an address is. That is not observable from
 *     `isIpAddress` alone — a second grammar could be reintroduced inside
 *     `resolveClientIp` tomorrow and this file would never notice if it only
 *     called the exported predicate. So every row is ALSO run through
 *     `resolveClientIp`'s own validating branch, and the two must match. That
 *     assertion is what goes red if a private near-copy comes back.
 *
 * HOW `resolveClientIp`'s BRANCH IS OBSERVED
 * ------------------------------------------
 * Its verdict is read off behaviour rather than by exporting an internal: an
 * ACCEPTED candidate is returned verbatim, a REJECTED one falls through to the
 * library resolver. A competing value is supplied so the fallback answers with
 * something that cannot be confused with any table entry — without it,
 * "accepted" and "the fallback happened to recover the same string" are
 * indistinguishable, and every row would pass for the wrong reason.
 *
 * WHY THE TABLE CARRIES NO UNTRIMMED OR NON-STRING VALUES
 * -------------------------------------------------------
 * The predicate is called with an already-trimmed string on every real path,
 * and does not trim internally. Padded input would report a result no caller
 * can produce. Non-string inputs ARE meaningful — the surviving signature takes
 * `unknown` — and are asserted separately below.
 */

const SOCKET_PEER = '10.42.0.9';

/**
 * The fallback's answer when the validating branch rejects. Chosen so it
 * collides with no table entry; a harness check below asserts that rather than
 * assuming it.
 */
const RESCUER = '198.51.100.77';

/** The fully-expanded IPv4-mapped IPv6 form — the longest text the grammar admits. */
const LONGEST_LEGAL_ADDRESS = '0000:0000:0000:0000:0000:ffff:255.255.255.255';

/** One character past the grammar's maximum. Length asserted, not assumed. */
const ONE_OVER_THE_LENGTH_BOUND = `${LONGEST_LEGAL_ADDRESS}5`;

function reqWith(headers: Record<string, string | string[]>): NextApiRequest {
  return { headers, socket: { remoteAddress: SOCKET_PEER } } as unknown as NextApiRequest;
}

/**
 * The verdict of the validating branch inside `resolveClientIp`.
 * `true` = the candidate was returned verbatim, i.e. accepted.
 */
function resolveBranchAccepts(value: string): boolean {
  return resolveClientIp(reqWith({ 'cf-connecting-ip': value, 'x-client-ip': RESCUER })) === value;
}

/**
 * The grammar, as a table of [description, input, EXPECTED VERDICT].
 *
 * 🔴 The third column is the whole point and is written independently: an
 * address is well-formed IPv4 or IPv6 text, carrying no IPv6 zone identifier,
 * no longer than 45 characters. Do NOT re-derive a row from the implementation
 * when it fails — that converts this file back into the vacuous self-comparison
 * it was written to replace.
 */
const GRAMMAR: ReadonlyArray<readonly [string, string, boolean]> = [
  // ── Accepted: well-formed, unscoped, within the length bound ──────────────
  ['an ordinary IPv4 address', '203.0.113.7', true],
  ['an IPv4 loopback', '127.0.0.1', true],
  ['an IPv4 broadcast address', '255.255.255.255', true],
  ['an ordinary IPv6 address', '2001:db8::1', true],
  ['an IPv6 loopback', '::1', true],
  ['an IPv6 link-local address', 'fe80::1', true],
  ['an IPv4-mapped IPv6 address', '::ffff:1.2.3.4', true],
  ['a full-width IPv6 address', '2400:cb00:2049:0001:0000:0000:a29f:1804', true],
  ['the longest legal address', LONGEST_LEGAL_ADDRESS, true],

  // ── Rejected: carries a zone identifier ───────────────────────────────────
  ['a zone-scoped IPv6 address', 'fe80::1%eth0', false],
  ['a zone-scoped address whose zone id is unbounded', `fe80::1%${'a'.repeat(4096)}`, false],
  ['a zone-scoped address with an empty zone id', 'fe80::1%', false],

  // ── Rejected: past the length bound ───────────────────────────────────────
  ['one character past the length bound', ONE_OVER_THE_LENGTH_BOUND, false],

  // ── Rejected: not address text at all ─────────────────────────────────────
  ['a bare integer that is also a plausible user id', '42', false],
  ['an over-long octet', '999.1.1.1', false],
  ['too many octets', '1.2.3.4.5', false],
  ['an arbitrary token', 'notanip', false],
  ['a redis-field-shaped string', 'user:42', false],
  ['the unresolvable-caller label itself', 'unknown', false],
  ['the empty string', '', false],
];

describe('client-ip: the one address grammar', () => {
  describe('harness self-checks', () => {
    /**
     * The branch oracle answers with a boolean, which is the shape that passes
     * when nothing is being observed. These checks are what say it is wired to
     * something: without them an oracle stuck on `false`, paired with a
     * predicate stuck on `false`, would agree perfectly across the whole table.
     */
    it('POSITIVE CONTROL: the oracle reports ACCEPT for a value that is accepted', () => {
      expect(resolveBranchAccepts('203.0.113.7')).toBe(true);
    });

    it('NEGATIVE CONTROL: the oracle reports REJECT, and names the fallthrough target', () => {
      expect(resolveBranchAccepts('notanip')).toBe(false);
      // Asserted explicitly: a reject must land on RESCUER, not on the socket
      // peer and not on an empty string. If the fallthrough target ever moves,
      // `resolveBranchAccepts` stops meaning what it says and this goes red.
      expect(
        resolveClientIp(reqWith({ 'cf-connecting-ip': 'notanip', 'x-client-ip': RESCUER }))
      ).toBe(RESCUER);
    });

    it('the rescuer collides with no table entry, so ACCEPT is never faked', () => {
      expect(GRAMMAR.map(([, value]) => value)).not.toContain(RESCUER);
    });

    it('the table is non-empty and carries BOTH verdicts', () => {
      // A table that had drifted to all-accept or all-reject would still satisfy
      // every assertion below while testing almost nothing. These are counts of
      // the WRITTEN-DOWN column, so they cannot be satisfied by the code.
      expect(GRAMMAR.length).toBeGreaterThanOrEqual(18);
      const expectedAccepts = GRAMMAR.filter(([, , expected]) => expected).length;
      const expectedRejects = GRAMMAR.length - expectedAccepts;
      expect(expectedAccepts, 'rows expected to be accepted').toBeGreaterThanOrEqual(8);
      expect(expectedRejects, 'rows expected to be rejected').toBeGreaterThanOrEqual(8);
    });

    it('the length fixtures really are 45 and 46 characters', () => {
      expect(LONGEST_LEGAL_ADDRESS).toHaveLength(45);
      expect(ONE_OVER_THE_LENGTH_BOUND).toHaveLength(46);
    });
  });

  describe('the exported predicate matches the written-down grammar', () => {
    it.each(GRAMMAR)('isIpAddress(%s) === %s', (label, value, expected) => {
      expect(
        isIpAddress(value),
        `isIpAddress disagrees with the grammar on ${label}. The expected verdict in the ` +
          `table is written from the address grammar, NOT from this implementation — if this ` +
          `fails, the implementation moved, so fix the code or argue the grammar. Do not ` +
          `re-derive the expectation from the code.`
      ).toBe(expected);
    });
  });

  describe('resolveClientIp validates through THAT SAME predicate, not a second copy', () => {
    /**
     * 🔴 THIS IS THE CONSOLIDATION GUARD. `client-ip.ts` used to carry a private
     * near-copy of the grammar that `resolveClientIp` called instead. Nothing
     * structural stopped the two drifting, and a divergence would have been
     * silent at every call site of both. Reintroducing such a copy — or editing
     * `resolveClientIp` to inline its own rule — makes these rows go red.
     */
    it.each(GRAMMAR)("resolveClientIp's branch on %s === %s", (label, value, expected) => {
      expect(
        resolveBranchAccepts(value),
        `resolveClientIp's validating branch disagrees with the grammar on ${label}. Either a ` +
          `second address rule has been reintroduced inside that function, or the shared ` +
          `predicate changed and this branch no longer calls it.`
      ).toBe(expected);
    });

    it('and agrees with the exported predicate on every row at once', () => {
      // The aggregate form, so no single row can be special-cased past this.
      expect(GRAMMAR.map(([, value]) => resolveBranchAccepts(value))).toEqual(
        GRAMMAR.map(([, value]) => isIpAddress(value))
      );
    });
  });

  describe('the three cases the consolidation must not lose', () => {
    /**
     * Called out individually because they are the reason the rule exists, and a
     * consolidation that quietly dropped one would still satisfy a table
     * comparison if the table were edited in the same commit.
     */
    it('a zone-scoped address is rejected on BOTH paths', () => {
      expect(isIpAddress('fe80::1%eth0'), 'isIpAddress').toBe(false);
      expect(resolveBranchAccepts('fe80::1%eth0'), "resolveClientIp's branch").toBe(false);
    });

    it('the longest legal address is accepted on BOTH paths', () => {
      expect(isIpAddress(LONGEST_LEGAL_ADDRESS), 'isIpAddress').toBe(true);
      expect(resolveBranchAccepts(LONGEST_LEGAL_ADDRESS), "resolveClientIp's branch").toBe(true);
    });

    it('a 46-character string is rejected on BOTH paths', () => {
      // The length bound moved ONTO the exported predicate in the consolidation
      // (it previously lived only on the private copy). This is the row that
      // says it arrived rather than being dropped in the fold.
      expect(isIpAddress(ONE_OVER_THE_LENGTH_BOUND), 'isIpAddress').toBe(false);
      expect(resolveBranchAccepts(ONE_OVER_THE_LENGTH_BOUND), "resolveClientIp's branch").toBe(
        false
      );
    });
  });

  describe('the surviving signature still narrows from unknown', () => {
    /**
     * The two originals differed in signature (`string` → `boolean` vs
     * `unknown` → type predicate), and the fold kept the WIDER one so both call
     * shapes are served. Pinned here so a later "tidy-up" cannot quietly reduce
     * the parameter to `string` and strip the guard from the `unknown`-typed
     * call sites (`getTrustedClientIp`, `fetchDownloadCount`).
     */
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 203],
      ['an array', ['203.0.113.7']],
      ['an object that stringifies to an address', { toString: () => '203.0.113.7' }],
    ])('isIpAddress rejects %s without throwing', (_label, value) => {
      expect(isIpAddress(value)).toBe(false);
    });

    it('narrows to string for a caller that needs it', () => {
      const value: unknown = '203.0.113.7';
      if (isIpAddress(value)) {
        // Compiles only while the return type is a type predicate. A signature
        // reduced to `(value: string) => boolean` would not narrow `unknown`,
        // and this line would stop type-checking.
        expect(value.length).toBe(11);
      } else {
        throw new Error('expected the predicate to accept a valid address');
      }
    });
  });
});
