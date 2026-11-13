import { createHash } from 'crypto';

/**
 * The `viewerKey` column of `appBlockEvents`. For a signed-in viewer: the first 8 bytes of
 * sha256(`'u:' + userId`), read big-endian. The derivation is fixed by the table's migration
 * header, which also gives the SQL that reproduces it.
 *
 * Returned as a DECIMAL STRING. The value can exceed 2^53, and a JSON number above that is
 * silently rounded on the way into the UInt64 column.
 */
export function signedInViewerKey(userId: number): string {
  return createHash('sha256').update(`u:${userId}`).digest().readBigUInt64BE(0).toString(10);
}

/** The key of every signed-out row: "unknown viewer". Never counted as a unique viewer. */
export const ANONYMOUS_VIEWER_KEY = '0';

/**
 * The rate-limit key for a canonical address (as `normalizeIp` writes it): an IPv6 address is
 * reduced to its /64, because one subscriber is routinely handed a whole /64 and could otherwise
 * take a fresh budget per address. IPv4 is used whole.
 */
export function rateLimitAddressKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [
        ...headGroups,
        ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'),
        ...tailGroups,
      ]
    : headGroups;
  return `${groups.slice(0, 4).join(':')}::/64`;
}
