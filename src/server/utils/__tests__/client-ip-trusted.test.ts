import { describe, it, expect, vi, afterEach } from 'vitest';
import { isIP } from 'node:net';
import {
  MALFORMED_LIST_CLIENT_MESSAGE,
  getTrustedClientIp,
  isIpAddress,
  parseIpBlocklist,
  parseUserBlocklist,
} from '../client-ip';

/**
 * Contract for the shared client-IP derivation used by the download
 * enforcement controls.
 *
 * The property under test is PROVENANCE, not formatting: the resolved value
 * must be a function of the edge attestation or the transport peer ONLY, and
 * must not move when a caller varies the forwarding headers it can compose.
 */

const EDGE_IP = '203.0.113.7';
const PEER_IP = '192.0.2.55';
const CALLER_CHOSEN = '198.51.100.9';

// Every forwarding header a caller can put on the wire. Each is asserted to be
// inert; the list is the ledger, so adding a header here is how a future
// resolver change gets caught.
const CALLER_SUPPLIED_HEADERS = [
  'x-client-ip',
  'x-forwarded-for',
  'x-real-ip',
  'true-client-ip',
  'fastly-client-ip',
  'x-cluster-client-ip',
  'forwarded-for',
  'forwarded',
] as const;

function req(headers: Record<string, string | string[]>, remoteAddress?: string) {
  return { headers, socket: remoteAddress ? { remoteAddress } : undefined };
}

describe('isIpAddress', () => {
  it('accepts IPv4 and IPv6', () => {
    expect(isIpAddress('203.0.113.7')).toBe(true);
    expect(isIpAddress('2001:db8::1')).toBe(true);
  });

  it('rejects non-addresses, including strings that could terminate a SQL literal', () => {
    expect(isIpAddress('')).toBe(false);
    expect(isIpAddress('not-an-ip')).toBe(false);
    expect(isIpAddress('203.0.113.7 OR 1=1')).toBe(false);
    expect(isIpAddress("1.1.1.1' OR '1'='1")).toBe(false);
    expect(isIpAddress('203.0.113.7:8080')).toBe(false);
    expect(isIpAddress(undefined)).toBe(false);
    expect(isIpAddress(12345)).toBe(false);
  });

  it('rejects a NON-STRING that node would coerce into a valid address', () => {
    // `net.isIP` coerces its argument, so `isIP(['1.2.3.4'])` is 4 and
    // `isIP({ toString: () => '1.2.3.4' })` is 4. The `typeof value === 'string'`
    // half of this predicate is therefore load-bearing and not a formality:
    // without it these values pass, the `value is string` type predicate becomes
    // a lie, and a non-string reaches a blocklist comparison and a query.
    //
    // None of these is reachable through a Node HTTP server today: node joins
    // duplicate headers into one comma-separated string (`set-cookie` is the
    // only header it turns into an array), so not even the array case arrives
    // that way. They are pinned because the parameter type is `unknown` and the
    // request type admits `string[]` — see the note on `headerValue` in
    // `client-ip.ts`, which is the same reasoning applied to the same fact.
    expect(isIpAddress(['1.2.3.4'])).toBe(false);
    expect(isIpAddress(['203.0.113.7', '198.51.100.9'])).toBe(false);
    // eslint-disable-next-line no-new-wrappers
    expect(isIpAddress(new String('1.2.3.4'))).toBe(false);
    expect(isIpAddress({ toString: () => '1.2.3.4' })).toBe(false);
  });
});

/**
 * An IPv6 zone identifier is the one construct `net.isIP` accepts at UNBOUNDED
 * length, and it is not part of a remote peer's identity — it names an interface
 * on the host that wrote it. Every consumer of this predicate uses the returned
 * string AS an identity (blocklist comparand, quota bucket key, ClickHouse query
 * literal), so admitting a freely-varying unbounded suffix into any of them is
 * an unbounded key space.
 */
describe('isIpAddress — an IPv6 zone id is not an identity', () => {
  it('POSITIVE CONTROL: node itself accepts these, so the rejection is this predicate doing work', () => {
    // Without this the assertions below are indistinguishable from "these
    // strings were never valid addresses in the first place".
    expect(isIP('fe80::1%eth0')).toBe(6);
    expect(isIP('fe80::1%' + 'a'.repeat(4096))).toBe(6);
    expect(isIP('::ffff:1.2.3.4%eth0')).toBe(6);
  });

  it.each([
    ['a link-local address with an interface zone', 'fe80::1%eth0'],
    ['a numeric zone', 'fe80::1%1'],
    ['a global address with a zone', '2001:db8::1%eth0'],
    ['an IPv4-mapped address with a zone', '::ffff:1.2.3.4%eth0'],
  ])('rejects %s', (_label, value) => {
    expect(isIpAddress(value)).toBe(false);
  });

  it('rejects a zone id of unbounded length', () => {
    // `net.isIP` places no ceiling on the zone id — this is the property that
    // makes the accepted value unbounded, and the reason a bare `net.isIP` is
    // not sufficient validation for a value used as a key.
    for (const n of [64, 1024, 4096]) {
      const scoped = 'fe80::1%' + 'a'.repeat(n);
      expect(isIP(scoped)).toBe(6); // node accepts it…
      expect(isIpAddress(scoped)).toBe(false); // …this predicate does not.
    }
  });

  it('every value this predicate accepts is bounded to 45 characters', () => {
    // The bound is a CONSEQUENCE of rejecting the zone id, so it is stated as a
    // property rather than left implicit. 45 is the longest text net.isIP
    // accepts without one.
    const longest = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
    expect(isIpAddress(longest)).toBe(true);
    expect(longest).toHaveLength(45);
    for (const v of [longest, '255.255.255.255', '2001:db8::1', '::1']) {
      expect(isIpAddress(v)).toBe(true);
      expect(v.length).toBeLessThanOrEqual(45);
    }
  });

  it('still accepts the unscoped forms of the same addresses', () => {
    // The complement: the rejection is of the zone id, not of IPv6.
    expect(isIpAddress('fe80::1')).toBe(true);
    expect(isIpAddress('2001:db8::1')).toBe(true);
    expect(isIpAddress('::ffff:1.2.3.4')).toBe(true);
  });
});

describe('getTrustedClientIp', () => {
  it('uses cf-connecting-ip when cf-ray attests the request came from the edge', () => {
    expect(
      getTrustedClientIp(req({ 'cf-ray': '8a1b2c3d4e5f6789-IAD', 'cf-connecting-ip': EDGE_IP }))
    ).toBe(EDGE_IP);
  });

  it('ignores cf-connecting-ip when cf-ray is absent, falling back to the transport peer', () => {
    expect(getTrustedClientIp(req({ 'cf-connecting-ip': CALLER_CHOSEN }, PEER_IP))).toBe(PEER_IP);
  });

  it('falls back to the transport peer when cf-connecting-ip is not a valid address', () => {
    expect(
      getTrustedClientIp(req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': 'garbage' }, PEER_IP))
    ).toBe(PEER_IP);
  });

  it('returns null when neither source yields an address', () => {
    expect(getTrustedClientIp(req({ 'x-client-ip': CALLER_CHOSEN }))).toBeNull();
  });

  it('normalizes an IPv4-mapped IPv6 peer to its dotted quad', () => {
    expect(getTrustedClientIp(req({}, '::ffff:192.0.2.55'))).toBe('192.0.2.55');
  });

  it('keeps a genuine IPv6 peer intact', () => {
    expect(getTrustedClientIp(req({}, '2001:db8::1'))).toBe('2001:db8::1');
  });

  it.each(CALLER_SUPPLIED_HEADERS)(
    'SECURITY: a caller-supplied %s does not change the edge-derived address',
    (header) => {
      const baseline = getTrustedClientIp(
        req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': EDGE_IP }, PEER_IP)
      );
      const withHeader = getTrustedClientIp(
        req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': EDGE_IP, [header]: CALLER_CHOSEN }, PEER_IP)
      );
      expect(withHeader).toBe(baseline);
      expect(withHeader).toBe(EDGE_IP);
      expect(withHeader).not.toBe(CALLER_CHOSEN);
    }
  );

  it.each(CALLER_SUPPLIED_HEADERS)(
    'SECURITY: a caller-supplied %s does not change the peer-derived address either',
    (header) => {
      const withHeader = getTrustedClientIp(req({ [header]: CALLER_CHOSEN }, PEER_IP));
      expect(withHeader).toBe(PEER_IP);
      expect(withHeader).not.toBe(CALLER_CHOSEN);
    }
  );

  it('SECURITY: rotating every forwarding header at once yields one stable value', () => {
    const rotate = (n: number) =>
      getTrustedClientIp(
        req(
          {
            'cf-ray': '8a1b-IAD',
            'cf-connecting-ip': EDGE_IP,
            ...Object.fromEntries(CALLER_SUPPLIED_HEADERS.map((h) => [h, `198.51.100.${n}`])),
          },
          PEER_IP
        )
      );
    const seen = new Set([rotate(1), rotate(2), rotate(3), rotate(200)]);
    expect([...seen]).toEqual([EDGE_IP]);
  });
});

describe('getTrustedClientIp — the transport-peer candidate is validated', () => {
  // The socket branch reads an address off the connection, which makes it easy
  // to assume it needs no checking. It does: the value reaches a blocklist
  // comparison and a ClickHouse query, and the module's contract is "a
  // validated address or null". A truthiness test in place of the validation
  // passes every one of the tests above, so these are what pin it.
  it.each([
    ['an empty-ish string', '   '],
    ['a hostname', 'localhost'],
    ['a truncated address', '203.0.113.'],
    ['an out-of-range quad', '203.0.113.999'],
    ['an address with a port', '203.0.113.7:8080'],
    ['a unix socket path', '/var/run/some.sock'],
    ['a string that could terminate a SQL literal', "1.1.1.1' OR '1'='1"],
  ])('returns null rather than %s from the socket', (_label, remoteAddress) => {
    expect(getTrustedClientIp(req({}, remoteAddress))).toBeNull();
  });

  it('returns null rather than a zone-scoped address from the socket', () => {
    // A scoped address would otherwise become the blocklist comparand and the
    // quota bucket key for that request.
    expect(getTrustedClientIp(req({}, 'fe80::1%eth0'))).toBeNull();
    expect(getTrustedClientIp(req({}, 'fe80::1%' + 'a'.repeat(4096)))).toBeNull();
  });

  it('a zone-scoped edge address falls through to the transport peer', () => {
    expect(
      getTrustedClientIp(req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': 'fe80::1%eth0' }, PEER_IP))
    ).toBe(PEER_IP);
  });

  it('SECURITY: varying the zone id cannot mint distinct buckets', () => {
    // The bucket-rotation shape: if a scoped address were accepted, each of
    // these would be a DIFFERENT key — an unbounded supply of fresh, empty
    // quota buckets and of values no blocklist entry can equal. They must all
    // collapse to the one value the derivation can actually attest.
    const rotate = (n: number) =>
      getTrustedClientIp(
        req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': `fe80::1%eth${n}` }, PEER_IP)
      );
    const seen = new Set([rotate(0), rotate(1), rotate(2), rotate(200)]);
    expect(seen.size, 'a varying zone id produced more than one bucket key').toBe(1);
    expect([...seen]).toEqual([PEER_IP]);
  });

  it('POSITIVE CONTROL: a valid socket address IS returned', () => {
    // Without this, every null above is indistinguishable from a socket branch
    // that never returns anything at all.
    expect(getTrustedClientIp(req({}, PEER_IP))).toBe(PEER_IP);
  });

  it('a padded socket address is trimmed rather than discarded', () => {
    // `isIP('  192.0.2.55  ')` is 0, so without the trim this resolves to null
    // and the request is attributed to nobody — a blocklist entry for that
    // address would stop matching. Pins why the `.trim()` is there.
    expect(getTrustedClientIp(req({}, `  ${PEER_IP}  `))).toBe(PEER_IP);
    expect(getTrustedClientIp(req({}, `\t${PEER_IP}\n`))).toBe(PEER_IP);
  });

  it('an unvalidated edge candidate does not fall through as the answer either', () => {
    // cf-ray present, cf-connecting-ip garbage, and no socket to fall back to.
    expect(getTrustedClientIp(req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': 'garbage' }))).toBe(
      null
    );
  });
});

describe('getTrustedClientIp — a REPEATED edge header is not trusted', () => {
  // Node's HTTP server joins duplicate headers into one comma-separated string,
  // so an array cannot arrive through a Node server today. The parameter type
  // admits one, though, and the pre-consolidation block-tokens resolver
  // required `typeof cfRay === 'string'` — i.e. it rejected arrays. These pin
  // that the consolidation kept that strictness instead of quietly picking an
  // element, which is the shape a "first vs last" edit could silently change.
  it('an array-valued cf-ray does not attest anything; the peer is used', () => {
    expect(
      getTrustedClientIp(
        req({ 'cf-ray': ['8a1b-IAD', '9c2d-LHR'], 'cf-connecting-ip': CALLER_CHOSEN }, PEER_IP)
      )
    ).toBe(PEER_IP);
  });

  it('an array-valued cf-connecting-ip is ignored even under a valid cf-ray', () => {
    expect(
      getTrustedClientIp(
        req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': [CALLER_CHOSEN, EDGE_IP] }, PEER_IP)
      )
    ).toBe(PEER_IP);
  });

  it('a repeated edge header yields null when there is no peer to fall back to', () => {
    expect(getTrustedClientIp(req({ 'cf-ray': ['8a1b-IAD'], 'cf-connecting-ip': [EDGE_IP] }))).toBe(
      null
    );
  });

  it('a blank or whitespace-only edge header is treated as absent', () => {
    expect(getTrustedClientIp(req({ 'cf-ray': '   ', 'cf-connecting-ip': EDGE_IP }, PEER_IP))).toBe(
      PEER_IP
    );
    expect(
      getTrustedClientIp(req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': '  ' }, PEER_IP))
    ).toBe(PEER_IP);
  });

  it('a padded edge header is trimmed rather than rejected', () => {
    expect(
      getTrustedClientIp(req({ 'cf-ray': ' 8a1b-IAD ', 'cf-connecting-ip': `  ${EDGE_IP}  ` }))
    ).toBe(EDGE_IP);
  });
});

describe('getTrustedClientIp — IPv4-mapped IPv6 is folded to the dotted quad', () => {
  // The blocklist comparison is exact string equality against text an operator
  // typed, so any mapped form that is NOT folded is an entry that silently
  // never matches. All three spellings denote the same address.
  it.each([
    ['canonical, as Node emits it', '::ffff:192.0.2.55'],
    ['zero groups written out', '0:0:0:0:0:ffff:192.0.2.55'],
    ['zero groups zero-padded', '0000:0000:0000:0000:0000:ffff:192.0.2.55'],
  ])('folds %s', (_label, mapped) => {
    expect(getTrustedClientIp(req({}, mapped))).toBe('192.0.2.55');
  });

  it('folds the low 32 bits written as hex groups', () => {
    // ::ffff:0102:0304 is the same address as ::ffff:1.2.3.4
    expect(getTrustedClientIp(req({}, '::ffff:0102:0304'))).toBe('1.2.3.4');
  });

  it('folds an edge-supplied mapped address too, not just the socket', () => {
    expect(
      getTrustedClientIp(req({ 'cf-ray': '8a1b-IAD', 'cf-connecting-ip': '::ffff:203.0.113.7' }))
    ).toBe('203.0.113.7');
  });

  it.each([
    ['a genuine IPv6 address', '2001:db8::1'],
    ['a genuine IPv6 address that merely starts with the same run', '::ffff:1:2:3'],
    ['the IPv6 loopback', '::1'],
    ['an IPv4 address, already canonical', '192.0.2.55'],
  ])('leaves %s untouched', (_label, ip) => {
    expect(getTrustedClientIp(req({}, ip))).toBe(ip);
  });

  it.each([
    ['the deprecated IPv4-COMPATIBLE form, which has no ffff run', '::1.2.3.4'],
    ['the same 32 bits as hex groups, again with no ffff run', '::0102:0304'],
  ])(
    'never folds %s to the dotted quad — the fold is keyed on the ffff run, not on any tail',
    (_label, ip) => {
      // 🔴 THE PROPERTY: a normalizer that ignored the prefix and folded
      // whatever followed `::` passed every other case in this file, and would
      // collapse the IPv4-COMPATIBLE address onto the dotted quad — making a
      // blocklist entry for `1.2.3.4` match a peer that is NOT at `1.2.3.4`.
      // That is the assertion; the exact text is not.
      const derived = getTrustedClientIp(req({}, ip));
      expect(derived).not.toBe('1.2.3.4');
      expect(isIP(derived!), 'the fold must still return an address').toBe(6);
      // It IS canonicalised, like any other IPv6 — these two labels are two
      // spellings of ONE address, so they must land on one text or a list entry
      // written in either spelling matches only half the peers that present it.
      expect(derived).toBe('::102:304');
    }
  );

  it('the fold is IDEMPOTENT — a derived address is already in its final form', () => {
    // Both sides of the blocklist comparison run through this fold. If it were
    // not idempotent, folding an entry that was already canonical would move it
    // and the two sides would separate again.
    for (const ip of [
      '203.0.113.7',
      '::ffff:203.0.113.7',
      '0:0:0:0:0:ffff:203.0.113.7',
      '2001:0DB8::1',
      '::1.2.3.4',
      '::1',
    ]) {
      const once = getTrustedClientIp(req({}, ip));
      expect(once).not.toBeNull();
      const twice = getTrustedClientIp(req({}, once!));
      expect(twice, `folding ${ip} twice moved it: ${once} -> ${twice}`).toBe(once);
    }
  });
});

describe('parseIpBlocklist', () => {
  it('splits a comma-separated list', () => {
    expect(parseIpBlocklist('1.2.3.4,5.6.7.8')).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('REGRESSION: trims entries, so a list written with spaces still matches', () => {
    // `'1.2.3.4, 5.6.7.8'.split(',')` yields a second entry of `' 5.6.7.8'`,
    // which cannot equal any address getTrustedClientIp returns. The control
    // then silently covers one fewer address than the operator wrote.
    const entries = parseIpBlocklist('1.2.3.4, 5.6.7.8 ,\t9.9.9.9\n');
    expect(entries).toEqual(['1.2.3.4', '5.6.7.8', '9.9.9.9']);
    expect(entries).toContain('5.6.7.8');
  });

  it('drops blank entries rather than emitting an empty string', () => {
    // An empty entry would match a caller whose derived address is `''` — not
    // reachable today, but only because every returned address is validated.
    expect(parseIpBlocklist('')).toEqual([]);
    expect(parseIpBlocklist('   ')).toEqual([]);
    expect(parseIpBlocklist('1.2.3.4,,5.6.7.8')).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(parseIpBlocklist('1.2.3.4, ,')).toEqual(['1.2.3.4']);
  });

  it('reads a MISSING row as an empty list, and REFUSES a malformed one', () => {
    // Absent is the ordinary "no list configured" state. A non-string is an
    // operator error, and the two must not look the same: reading a malformed
    // row as "no entries" switches the control off in the allow direction.
    expect(parseIpBlocklist(undefined)).toEqual([]);
    expect(parseIpBlocklist(null)).toEqual([]);
    expect(() => parseIpBlocklist(42)).toThrow(TypeError);
    expect(() => parseIpBlocklist({ value: '1.2.3.4' })).toThrow(TypeError);
  });

  it('FAIL DIRECTION: a malformed row denies rather than disabling the control', () => {
    // `KeyValue.value` is a `Json` column, so a non-string is representable.
    // Reading one as "no entries" would switch an enforcement control off in the
    // ALLOW direction, and a control that is off is indistinguishable at the
    // call site from a caller who is simply not listed. It throws instead, which
    // surfaces as a 5xx the endpoint wrappers already count.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => parseIpBlocklist(42)).toThrow(TypeError);
      expect(() => parseUserBlocklist({ nope: true })).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }

    // An ABSENT row is the normal "no list configured" state, not a fault.
    expect(parseIpBlocklist(undefined)).toEqual([]);
    expect(parseIpBlocklist(null)).toEqual([]);
    expect(parseUserBlocklist(undefined)).toEqual([]);
    expect(parseUserBlocklist(null)).toEqual([]);

    // A well-formed row is likewise fine.
    expect(parseIpBlocklist('1.2.3.4')).toEqual(['1.2.3.4']);
  });
});

describe('parseIpBlocklist — an entry is folded the same way the derived address is', () => {
  /**
   * 🔴 THE INVARIANT: for any address, an entry written in ANY legal spelling
   * must compare equal to the value `getTrustedClientIp` returns for a peer at
   * that address. The comparison at every call site is exact string equality,
   * so a fold applied to one side only makes the two MORE likely to disagree,
   * not less — the derived value moves to the canonical text and an entry
   * written another way stops matching an address it used to match.
   *
   * An entry that never matches is invisible from outside: the request simply
   * succeeds, exactly as it would for a caller who is not listed at all.
   *
   * Each case below is driven end-to-end — a real request through
   * `getTrustedClientIp`, compared against a real parsed list — rather than
   * asserting the parser's output shape. What matters is that the two meet.
   */
  const derivedFrom = (remoteAddress: string) => getTrustedClientIp({ socket: { remoteAddress } });

  const SPELLINGS: Array<{ label: string; entry: string; peer: string }> = [
    // IPv4-mapped IPv6. Node reports an IPv4 peer on a dual-stack listener in
    // the mapped form; an operator writes the dotted quad. Both spellings of
    // the entry must reach the same place.
    { label: 'mapped, canonical', entry: '::ffff:203.0.113.7', peer: '::ffff:203.0.113.7' },
    { label: 'mapped entry vs dotted peer', entry: '::ffff:203.0.113.7', peer: '203.0.113.7' },
    { label: 'dotted entry vs mapped peer', entry: '203.0.113.7', peer: '::ffff:203.0.113.7' },
    {
      label: 'mapped, zero groups written out',
      entry: '0:0:0:0:0:ffff:203.0.113.7',
      peer: '203.0.113.7',
    },
    { label: 'mapped, low 32 bits as hex', entry: '::ffff:cb00:7107', peer: '203.0.113.7' },
    // Plain IPv6 written non-canonically. One address, many legal texts.
    { label: 'IPv6 with leading zeroes', entry: '2001:0db8::1', peer: '2001:db8::1' },
    { label: 'IPv6 fully expanded', entry: '2001:db8:0:0:0:0:0:1', peer: '2001:db8::1' },
    { label: 'IPv6 upper case', entry: '2001:DB8::1', peer: '2001:db8::1' },
    { label: 'IPv6 non-canonical peer', entry: '2001:db8::1', peer: '2001:0DB8:0:0:0:0:0:1' },
  ];

  it.each(SPELLINGS)('matches a $label entry', ({ entry, peer }) => {
    const derived = derivedFrom(peer);
    expect(derived, 'the peer did not resolve to an address at all').not.toBeNull();
    expect(
      parseIpBlocklist(entry).includes(derived!),
      `entry ${entry} did not match a peer at ${peer} (derived: ${derived}) — the two sides of ` +
        `the blocklist comparison are not folded the same way, so this entry silently covers ` +
        `nothing`
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: folding does not make one address match a different one', () => {
    // The fold changes the SPELLING of an address and never which address it
    // denotes. Without this, a fold that over-normalised — mapping everything
    // to one value — would pass every case above.
    const derived = derivedFrom('203.0.113.7');
    for (const other of [
      '203.0.113.8',
      '203.0.113.70',
      '::ffff:203.0.113.8',
      '2001:db8::1',
      '0.0.0.0',
    ]) {
      expect(
        parseIpBlocklist(other).includes(derived!),
        `entry ${other} matched a peer at 203.0.113.7`
      ).toBe(false);
    }
    // And an empty list still matches nobody.
    expect(parseIpBlocklist('').includes(derived!)).toBe(false);
  });

  it('leaves a non-address entry alone rather than guessing at it', () => {
    // Operators mistype. A fold that mangled an unparseable entry would change
    // what the row means without saying so.
    expect(parseIpBlocklist('not-an-ip, 203.0.113.0/24, 203.0.113.7')).toEqual([
      'not-an-ip',
      '203.0.113.0/24',
      '203.0.113.7',
    ]);
  });

  it('user-blacklist entries are NOT put through an address fold', () => {
    // Its entries are user ids. An address fold has no meaning on one, and
    // applying it would be a silent behaviour change on a different control.
    expect(parseUserBlocklist('123, 456, 0:0:0:0:0:ffff:1.2.3.4')).toEqual([
      '123',
      '456',
      '0:0:0:0:0:ffff:1.2.3.4',
    ]);
  });
});

describe('parseKeyValueList — a malformed row tells the operator, not the caller', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * 🔴 THE THROWN MESSAGE REACHES AN UNAUTHENTICATED CALLER. These lists are
   * read by public download routes, and both paths out of a throw put
   * `error.message` in the response body. So the row's identity and the type it
   * held are an OPERATOR signal and belong on the server log; the client gets a
   * fixed, content-free string.
   *
   * Both halves are pinned, because dropping either is a plausible edit: a
   * message that names the row again is a leak, and a log that is removed to
   * "clean up" takes away the only reason to throw rather than return `[]`.
   */
  const INTERNAL_TOKENS = ['ip-blacklist', 'user-blacklist', 'KeyValue', 'object', 'number'];

  it.each([
    ['ip-blacklist', () => parseIpBlocklist({ not: 'a string' })],
    ['user-blacklist', () => parseUserBlocklist(42)],
  ])('the CLIENT-VISIBLE message for a malformed %s names nothing internal', (_row, call) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let thrown: unknown;
    try {
      call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a malformed row must still fail closed').toBeInstanceOf(TypeError);
    const message = (thrown as Error).message;
    expect(message).toBe(MALFORMED_LIST_CLIENT_MESSAGE);
    for (const token of INTERNAL_TOKENS) {
      expect(message.toLowerCase(), `the client-visible message leaks '${token}'`).not.toContain(
        token.toLowerCase()
      );
    }
  });

  it('the OPERATOR signal — row key and actual type — goes to the server log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => parseIpBlocklist({ not: 'a string' })).toThrow(TypeError);
    expect(
      spy,
      'nothing was logged, so an operator has no way to find the bad row'
    ).toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('ip-blacklist');
    expect(logged).toContain('object');

    spy.mockClear();
    expect(() => parseUserBlocklist(42)).toThrow(TypeError);
    const logged2 = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged2).toContain('user-blacklist');
    expect(logged2).toContain('number');
  });

  it('NEGATIVE CONTROL: a well-formed or absent row logs nothing and throws nothing', () => {
    // Without this, a `console.error` on every call would satisfy the assertion
    // above while making the log useless.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseIpBlocklist('1.2.3.4')).toEqual(['1.2.3.4']);
    expect(parseIpBlocklist(undefined)).toEqual([]);
    expect(parseIpBlocklist(null)).toEqual([]);
    expect(parseUserBlocklist('123')).toEqual(['123']);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('parseUserBlocklist', () => {
  it('trims entries, so every id after the first still matches', () => {
    // Entries are compared with exact string equality against
    // `session.user.id.toString()`, so an entry carrying a leading space can
    // never match. Every entry must come out of the split trimmed, whatever
    // spacing the operator wrote.
    const entries = parseUserBlocklist('123, 456 ,\t789\n');
    expect(entries).toEqual(['123', '456', '789']);
    expect(entries).toContain('456');
  });

  it('an entry after the first matches when the list is written with spaces', () => {
    expect(parseUserBlocklist('123, 456')).toContain('456');
  });

  it('drops blanks, so an empty row never matches a user id', () => {
    // An entry of `''` would make the list non-empty while matching no real id.
    expect(parseUserBlocklist('')).toEqual([]);
    expect(parseUserBlocklist('  ')).toEqual([]);
    expect(parseUserBlocklist('123,,456')).toEqual(['123', '456']);
    expect(parseUserBlocklist('')).not.toContain('');
  });

  it('reads a MISSING row as an empty list, and REFUSES a malformed one', () => {
    expect(parseUserBlocklist(undefined)).toEqual([]);
    expect(parseUserBlocklist(null)).toEqual([]);
    expect(() => parseUserBlocklist(42)).toThrow(TypeError);
  });
});
