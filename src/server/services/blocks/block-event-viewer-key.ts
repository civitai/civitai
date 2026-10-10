import { createHash } from 'crypto';
import { isIpAddress, normalizeIp } from '~/server/utils/client-ip';

/**
 * The `viewerKey` column of `appBlockEvents`: the first 8 bytes of a sha256 digest, read
 * big-endian. The derivation is fixed by the table's migration header, which also gives the SQL
 * that reproduces it; changing either side alone splits every viewer in two.
 *
 * Returned as a DECIMAL STRING. The value can exceed 2^53, and a JSON number above that is
 * silently rounded on the way into the UInt64 column.
 */
function viewerKeyOf(input: string): string {
  return createHash('sha256').update(input).digest().readBigUInt64BE(0).toString(10);
}

export function signedInViewerKey(userId: number): string {
  return viewerKeyOf(`u:${userId}`);
}

/**
 * One address, one spelling: an IPv4-mapped IPv6 address becomes its IPv4 form and IPv6 is
 * written in lower-case canonical form. `null` for anything that is not an address, so a
 * placeholder such as an "unknown" label can never be hashed into a key that looks like a viewer.
 */
export function normalizeViewerIp(ip: unknown): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  return isIpAddress(trimmed) ? normalizeIp(trimmed) : null;
}

/**
 * The rate-limit key for an address already normalised by {@link normalizeViewerIp}: an IPv6
 * address is reduced to its /64, because one subscriber is routinely handed a whole /64 and
 * could otherwise take a fresh budget per address. IPv4 is used whole.
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

/** `ip` must already be normalised by {@link normalizeViewerIp}. */
export function signedOutViewerKey(daySalt: string, ip: string): string {
  return viewerKeyOf(`a:${daySalt}:${ip}`);
}
