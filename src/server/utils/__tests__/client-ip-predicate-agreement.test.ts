import { describe, it, expect } from 'vitest';
import type { NextApiRequest } from 'next';

import { isIpAddress, resolveClientIp } from '../client-ip';

/**
 * RELATIONSHIP GUARD for the two address validators in `client-ip.ts`.
 *
 * `client-ip.ts` holds two predicates that apply the same rule to the same
 * grammar: `isBareAddress` (private, used by `resolveClientIp`) and the
 * exported `isIpAddress` (used by `getTrustedClientIp` and by
 * `fetchDownloadCount`). They arrived from two different PRs that each created
 * that module, and the add/add merge kept both rather than folding them —
 * deliberately, because collapsing two validators would move a rate limiter and
 * a blocklist in one commit. That decision is recorded in the module's header.
 *
 * The cost of keeping both is that nothing structural holds them together:
 * neither fails when the other changes. This file is what holds them together
 * until the follow-up consolidates them. It is NOT a test of either predicate's
 * correctness — `client-ip.test.ts` and `client-ip-trusted.test.ts` own that —
 * it asserts only the RELATIONSHIP: for every input in one shared table, both
 * reach the same accept/reject verdict. Divergence in either direction is a
 * failure, so this stays honest whichever one is edited.
 *
 * HOW `isBareAddress` IS OBSERVED
 * -------------------------------
 * It is module-private and stays that way — exporting an internal purely to
 * test it would widen the surface of a security-sensitive module, and the
 * production path exercises it anyway. Its verdict is read through
 * `resolveClientIp`'s CF branch: an ACCEPTED candidate is returned verbatim,
 * and a REJECTED one falls through to the library resolver. A competing
 * `x-client-ip` is supplied so the fallback answers with a value that cannot be
 * confused with any table entry — without it, "accepted" and "the fallback
 * happened to recover the same string" are indistinguishable.
 *
 * WHY THE TABLE CARRIES NO UNTRIMMED OR NON-STRING VALUES
 * -------------------------------------------------------
 * Both predicates are called with an already-trimmed string on every real call
 * path (`resolveClientIp` trims the header, `getTrustedClientIp` trims via
 * `headerValue` and via `.trim()` on the socket address), and neither trims
 * internally. Feeding padded input here would report a divergence that no
 * caller can produce. Likewise the signatures differ on purpose — `unknown` vs
 * `string` — so non-string inputs are only meaningful for `isIpAddress` and are
 * asserted separately below rather than in the shared table.
 */

const SOCKET_PEER = '10.42.0.9';

/**
 * The fallback's answer when the CF branch rejects. Chosen so it collides with
 * no table entry; the harness self-check below asserts that.
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
 * `isBareAddress`'s verdict, read off the branch that uses it.
 * `true` = the candidate was returned verbatim, i.e. accepted.
 */
function bareAddressAccepts(value: string): boolean {
  return resolveClientIp(reqWith({ 'cf-connecting-ip': value, 'x-client-ip': RESCUER })) === value;
}

/**
 * The shared table. Every entry is run through BOTH predicates and the two
 * verdicts are compared to each other — the expected verdict is deliberately
 * NOT written down here, because an expectation copied from either
 * implementation would move with a mutation of it. What is written down is the
 * count of each verdict (below), which is what stops the whole table drifting
 * to one side unnoticed.
 */
const SHARED_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ['an ordinary IPv4 address', '203.0.113.7'],
  ['an IPv4 loopback', '127.0.0.1'],
  ['an ordinary IPv6 address', '2001:db8::1'],
  ['an IPv6 loopback', '::1'],
  ['an IPv6 link-local address', 'fe80::1'],
  ['an IPv4-mapped IPv6 address', '::ffff:1.2.3.4'],
  ['a full-width IPv6 address', '2400:cb00:2049:0001:0000:0000:a29f:1804'],
  ['the longest legal address', LONGEST_LEGAL_ADDRESS],
  ['a zone-scoped IPv6 address', 'fe80::1%eth0'],
  ['a zone-scoped address whose zone id is unbounded', `fe80::1%${'a'.repeat(4096)}`],
  ['a zone-scoped address with an empty zone id', 'fe80::1%'],
  ['one character past the length bound', ONE_OVER_THE_LENGTH_BOUND],
  ['a bare integer that is also a plausible user id', '42'],
  ['an over-long octet', '999.1.1.1'],
  ['too many octets', '1.2.3.4.5'],
  ['an arbitrary token', 'notanip'],
  ['a redis-field-shaped string', 'user:42'],
  ['the unresolvable-caller label itself', 'unknown'],
];

describe('client-ip: the two address predicates agree', () => {
  describe('harness self-checks', () => {
    /**
     * The assertions in this file are all of the form "two things are equal",
     * which is exactly the shape that passes when neither thing is being
     * observed. These four checks are what say the oracle is wired to
     * something. Without them a `bareAddressAccepts` that always returned
     * `false`, paired with an `isIpAddress` that always returned `false`, would
     * report perfect agreement across the whole table.
     */
    it('POSITIVE CONTROL: the oracle reports ACCEPT for a value that is accepted', () => {
      expect(bareAddressAccepts('203.0.113.7')).toBe(true);
    });

    it('NEGATIVE CONTROL: the oracle reports REJECT, and names the fallthrough target', () => {
      expect(bareAddressAccepts('notanip')).toBe(false);
      // Asserted explicitly: a reject must land on RESCUER, not on the socket
      // peer and not on an empty string. If the fallthrough target ever moves,
      // `bareAddressAccepts` stops meaning what it says and this goes red.
      expect(
        resolveClientIp(reqWith({ 'cf-connecting-ip': 'notanip', 'x-client-ip': RESCUER }))
      ).toBe(RESCUER);
    });

    it('the rescuer collides with no table entry, so ACCEPT is never faked', () => {
      expect(SHARED_INPUTS.map(([, value]) => value)).not.toContain(RESCUER);
    });

    it('the table is non-empty and carries BOTH verdicts', () => {
      // A table that had drifted to all-accept or all-reject would still pass
      // every agreement assertion below while testing almost nothing.
      expect(SHARED_INPUTS.length).toBeGreaterThanOrEqual(15);
      const verdicts = SHARED_INPUTS.map(([, value]) => isIpAddress(value));
      expect(verdicts.filter(Boolean).length, 'accepted inputs').toBeGreaterThanOrEqual(6);
      expect(verdicts.filter((v) => !v).length, 'rejected inputs').toBeGreaterThanOrEqual(6);
    });

    it('the length fixtures really are 45 and 46 characters', () => {
      expect(LONGEST_LEGAL_ADDRESS).toHaveLength(45);
      expect(ONE_OVER_THE_LENGTH_BOUND).toHaveLength(46);
    });
  });

  describe('every shared input gets the same verdict from both', () => {
    it.each(SHARED_INPUTS)('isBareAddress and isIpAddress agree on %s', (label, value) => {
      const bare = bareAddressAccepts(value);
      const exported = isIpAddress(value);
      expect(
        bare,
        `isBareAddress and isIpAddress disagree on ${label} (${JSON.stringify(
          value.length > 64 ? `${value.slice(0, 64)}…` : value
        )}): resolveClientIp's branch ${bare ? 'accepted' : 'rejected'} it, isIpAddress ${
          exported ? 'accepted' : 'rejected'
        } it. These two are required to stay behaviourally identical until the follow-up folds them together — see the lockstep notes in client-ip.ts.`
      ).toBe(exported);
    });

    it('and agree in aggregate, so no single case can be special-cased past this', () => {
      const bare = SHARED_INPUTS.map(([, value]) => bareAddressAccepts(value));
      const exported = SHARED_INPUTS.map(([, value]) => isIpAddress(value));
      expect(bare).toEqual(exported);
    });
  });

  describe('the three cases the follow-up must not lose', () => {
    /**
     * Called out individually because they are the reason the rule exists, and
     * a consolidation that quietly dropped one would still satisfy a table
     * comparison if the table were edited in the same commit.
     */
    it('a zone-scoped address is rejected by BOTH', () => {
      expect(bareAddressAccepts('fe80::1%eth0'), 'isBareAddress').toBe(false);
      expect(isIpAddress('fe80::1%eth0'), 'isIpAddress').toBe(false);
    });

    it('the longest legal address is accepted by BOTH', () => {
      expect(bareAddressAccepts(LONGEST_LEGAL_ADDRESS), 'isBareAddress').toBe(true);
      expect(isIpAddress(LONGEST_LEGAL_ADDRESS), 'isIpAddress').toBe(true);
    });

    it('a 46-character string is rejected by BOTH', () => {
      expect(bareAddressAccepts(ONE_OVER_THE_LENGTH_BOUND), 'isBareAddress').toBe(false);
      expect(isIpAddress(ONE_OVER_THE_LENGTH_BOUND), 'isIpAddress').toBe(false);
    });
  });

  describe('the signatures differ on purpose, and that is not the duplication', () => {
    /**
     * `isIpAddress` takes `unknown` and narrows; `isBareAddress` takes `string`.
     * Non-string inputs are therefore outside the shared table — there is no
     * `isBareAddress` verdict to compare against, and no caller produces one.
     * Pinned here so a consolidation keeps the narrowing rather than quietly
     * reducing the exported predicate to a `string` parameter.
     */
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 203],
      ['an array', ['203.0.113.7']],
      ['an object', { toString: () => '203.0.113.7' }],
    ])('isIpAddress rejects %s without throwing', (_label, value) => {
      expect(isIpAddress(value)).toBe(false);
    });
  });
});
