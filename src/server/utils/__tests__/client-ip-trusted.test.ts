import { describe, it, expect } from 'vitest';
import { getTrustedClientIp, isIpAddress, parseIpBlocklist } from '../client-ip';

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
    // a lie, and a non-string reaches a blocklist comparison and a query. The
    // array case is the reachable one — a repeated header arrives as an array.
    expect(isIpAddress(['1.2.3.4'])).toBe(false);
    expect(isIpAddress(['203.0.113.7', '198.51.100.9'])).toBe(false);
    // eslint-disable-next-line no-new-wrappers
    expect(isIpAddress(new String('1.2.3.4'))).toBe(false);
    expect(isIpAddress({ toString: () => '1.2.3.4' })).toBe(false);
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

  it('reads a missing or non-string row as an empty list, never as a match', () => {
    expect(parseIpBlocklist(undefined)).toEqual([]);
    expect(parseIpBlocklist(null)).toEqual([]);
    expect(parseIpBlocklist(42)).toEqual([]);
    expect(parseIpBlocklist({ value: '1.2.3.4' })).toEqual([]);
  });
});
