/**
 * Where a subscription comes from, for both bindings, read with the site's own helpers rather
 * than re-derived:
 *
 *   - whether its region is held to SFW content: a region the site restricts to SFW
 *     (`isRegionRestricted`, `REGION_RESTRICTION_CONFIG`) or one the site blocks outright
 *     (`isRegionBlocked`, `REGION_BLOCK_CONFIG`; the public API answers it 451), both over
 *     `getRegion`, as the site's middleware and the public API's `apiBrowsingLevel` read them.
 *     A blocked region is held to SFW rather than refused: the registry protocol has no error for
 *     "not served in your region", so refusing it waits on one. Unlike the site, a request whose
 *     country cannot be told is held to SFW as well (fail closed, `countryKnown`): no
 *     `cf-ipcountry` (and no `x-isuk`), an empty one, the edge's `XX` (country unknown) or `T1`
 *     (Tor), or anything else that is not a two-letter code. The site serves such a request
 *     unrestricted; here it would be every request that reached this process some way other than
 *     through the edge, so a missing header cannot mean "unrestricted". A US request with a
 *     country but no `cf-region-code` is judged by its country alone, as on the site;
 *   - the client address a per-client limit is keyed on: `resolveClientIp`, the site's predicate
 *     for rate-limit keys (`limits.ts`).
 *
 * An HTTP request's origin is its headers and socket address; a gRPC call's is its metadata and
 * peer address, the same header names a proxy sets on either.
 *
 * 🔴 Trust. Every value here is taken from the request as it arrives:
 *   - the region headers (`cf-ipcountry`, `cf-region-code`, `x-isuk`) and the forwarded client
 *     address are trustworthy only when the edge in front of this process sets them and strips
 *     any a client sent. Reached any other way, a client that sends a region header chooses its
 *     own region (and so whether it is held to SFW) and its own address for the per-address cap;
 *     one that sends none is held to SFW;
 *   - a relay that forwards a user's token is judged by the RELAY's request, not the user's. A
 *     relay that does not forward the edge's region headers sends none, so every user behind it
 *     is held to SFW, whatever their region; one that does forward them is served as the region
 *     they name, so it must forward the edge's values and never a client's;
 *   - the per-address cap counts a relay as one address, however many users it serves.
 */
import type { IncomingMessage } from 'node:http';
import type { NextApiRequest } from 'next';
import { resolveClientIp } from '~/server/utils/client-ip';
import type { RegionBlockConfig, RegionInfo } from '~/server/utils/region-blocking';
import {
  REGION_BLOCK_CONFIG,
  REGION_RESTRICTION_CONFIG,
  getRegion,
  isRegionBlocked,
  isRegionRestricted,
} from '~/server/utils/region-blocking';

export type RequestOrigin = {
  /** Lowercase header names, as Node and gRPC metadata both give them. */
  headers: Record<string, string | string[] | undefined>;
  /** The transport peer's address, without its port. */
  remoteAddress?: string;
};

/** The edge's country codes that name no country: `XX`, no country known; `T1`, Tor. */
const NO_COUNTRY = new Set(['XX', 'T1']);

/**
 * Whether `region` names a country: a two-letter code other than the edge's {@link NO_COUNTRY}
 * codes. Missing, empty, a repeated header joined into one value, or anything else does not.
 */
export function countryKnown(region: Pick<RegionInfo, 'countryCode'>): boolean {
  const code = region.countryCode;
  if (typeof code !== 'string') return false;
  const upper = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) && !NO_COUNTRY.has(upper);
}

/**
 * Whether `origin` is held to SFW content at `at`: a request whose country cannot be told
 * (`countryKnown`), a region the site restricts to SFW, or one it blocks (see the file comment).
 */
export function regionRestricted(origin: RequestOrigin, at: Date = new Date()): boolean {
  const region = getRegion({ headers: origin.headers } as unknown as IncomingMessage);
  if (!countryKnown(region)) return true;
  return isRegionRestricted(region, at) || isRegionBlocked(region, at);
}

/** The client address of `origin`, as the site keys a per-client limit on it. */
export function clientAddress(origin: RequestOrigin): string {
  const socket = { remoteAddress: origin.remoteAddress };
  return resolveClientIp({
    headers: origin.headers,
    socket,
    connection: socket,
  } as unknown as NextApiRequest);
}

/**
 * The address in a gRPC peer string (`call.getPeer()`): `1.2.3.4:5678`, `[::1]:5678`, either
 * with an `ipv4:` / `ipv6:` scheme; `undefined` for anything else (a unix socket).
 */
export function peerAddress(peer: string | undefined): string | undefined {
  if (!peer) return undefined;
  const bare = peer.replace(/^ipv[46]:/, '');
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(bare);
  if (v6) return v6[1];
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(bare);
  return v4?.[1];
}

/**
 * The startup lines describing the region lists in force, so a missing configuration is visible:
 * each list's count and codes (with effective dates), that a request with no region is held to
 * SFW, and a warning when no region is restricted.
 */
export function describeRegionConfig(
  restricted: readonly RegionBlockConfig[] = REGION_RESTRICTION_CONFIG,
  blocked: readonly RegionBlockConfig[] = REGION_BLOCK_CONFIG
): { info: string[]; warn: string[] } {
  const list = (configs: readonly RegionBlockConfig[]) =>
    configs.length === 0
      ? 'none'
      : configs.map((c) => `${c.region} from ${c.effectiveDate}`).join(', ');
  const info = [
    `SFW-restricted regions (${restricted.length}): ${list(restricted)}`,
    `blocked regions, held to SFW (${blocked.length}): ${list(blocked)}`,
    'a request with no region (no country header, XX or T1) is held to SFW',
  ];
  const warn =
    restricted.length === 0
      ? [
          'REGION_RESTRICTION_CONFIG is empty or unset: no region is restricted to SFW ' +
            '(blocked regions, and requests with no region, still are); set it as the site does',
        ]
      : [];
  return { info, warn };
}
