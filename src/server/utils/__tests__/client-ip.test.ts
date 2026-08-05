import { describe, it, expect } from 'vitest';
import { getTrustedClientIp, isIpAddress } from '../client-ip';

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
