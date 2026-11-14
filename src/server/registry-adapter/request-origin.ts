/**
 * Where a subscription comes from, for both bindings, read with the site's own helpers rather
 * than re-derived:
 *
 *   - whether its region is one the site restricts to SFW content: `isRegionRestricted` over
 *     `getRegion`, the pair the site's region-restriction middleware and the public API's
 *     `apiBrowsingLevel` use. So it is configured as the site is (`REGION_RESTRICTION_CONFIG`),
 *     and, as on the site, a request whose region cannot be told (no `cf-ipcountry`) is not
 *     restricted;
 *   - the client address a per-client limit is keyed on: `resolveClientIp`, the site's predicate
 *     for rate-limit keys (`limits.ts`).
 *
 * An HTTP request's origin is its headers and socket address; a gRPC call's is its metadata and
 * peer address, the same header names a proxy sets on either.
 */
import type { IncomingMessage } from 'node:http';
import type { NextApiRequest } from 'next';
import { resolveClientIp } from '~/server/utils/client-ip';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

export type RequestOrigin = {
  /** Lowercase header names, as Node and gRPC metadata both give them. */
  headers: Record<string, string | string[] | undefined>;
  /** The transport peer's address, without its port. */
  remoteAddress?: string;
};

/** Whether `origin` is a region the site restricts to SFW content, at `at`. */
export function regionRestricted(origin: RequestOrigin, at: Date = new Date()): boolean {
  return isRegionRestricted(
    getRegion({ headers: origin.headers } as unknown as IncomingMessage),
    at
  );
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
