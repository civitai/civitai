/**
 * Where a subscription comes from, for both bindings, read with the site's own helpers rather
 * than re-derived:
 *
 *   - whether its region is held to SFW content: a region the site restricts to SFW
 *     (`isRegionRestricted`, `REGION_RESTRICTION_CONFIG`) or one the site blocks outright
 *     (`isRegionBlocked`, `REGION_BLOCK_CONFIG`; the public API answers it 451), both over
 *     `getRegion`, as the site's middleware and the public API's `apiBrowsingLevel` read them.
 *     A blocked region is held to SFW rather than refused: the registry protocol has no error for
 *     "not served in your region", so refusing it waits on one. As on the site, a request whose
 *     region cannot be told (no `cf-ipcountry`) is neither;
 *   - the client address a per-client limit is keyed on: `resolveClientIp`, the site's predicate
 *     for rate-limit keys (`limits.ts`).
 *
 * An HTTP request's origin is its headers and socket address; a gRPC call's is its metadata and
 * peer address, the same header names a proxy sets on either.
 *
 * 🔴 Trust. Every value here is taken from the request as it arrives:
 *   - the region headers (`cf-ipcountry`, `cf-region-code`, `x-isuk`) and the forwarded client
 *     address are trustworthy only when the edge in front of this process sets them and strips
 *     any a client sent. Reached any other way, a client chooses its own region (and so whether
 *     it is held to SFW) and its own address for the per-address cap;
 *   - a relay that forwards a user's token is judged by the RELAY's request: its region and its
 *     address, not the user's. A user behind a relay in an unrestricted region is served as that
 *     region is, so a relay serving users of a restricted region must apply the rule itself;
 *   - the per-address cap counts a relay as one address, however many users it serves.
 */
import type { IncomingMessage } from 'node:http';
import type { NextApiRequest } from 'next';
import { resolveClientIp } from '~/server/utils/client-ip';
import type { RegionBlockConfig } from '~/server/utils/region-blocking';
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

/**
 * Whether `origin` is held to SFW content at `at`: a region the site restricts to SFW, or one it
 * blocks (see the file comment).
 */
export function regionRestricted(origin: RequestOrigin, at: Date = new Date()): boolean {
  const region = getRegion({ headers: origin.headers } as unknown as IncomingMessage);
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
 * each list's count and codes (with effective dates), and a warning when no region is restricted.
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
  ];
  const warn =
    restricted.length === 0
      ? [
          'REGION_RESTRICTION_CONFIG is empty or unset: no region is restricted to SFW ' +
            '(blocked regions still are); set it as the site does',
        ]
      : [];
  return { info, warn };
}
