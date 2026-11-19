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
 *     for rate-limit keys (`limits.ts`);
 *   - the one line each subscription logs as it starts (`describeRegion`, `regionLine`): the
 *     country and region judged, whether they came from `meta` or a header, and the SFW hold,
 *     so production shows which source decided. Never the address, token or user.
 *
 * An HTTP request's origin is its headers and socket address; a gRPC call's is its metadata and
 * peer address, the same header names a proxy sets on either. With {@link metaTrusted} on
 * (`REGISTRY_ADAPTER_TRUST_META=1`), a region value on both may also come from the request's
 * `meta` (the registry spec's rule 10) under the key {@link REGION_META_KEYS} names for its
 * header: a string there wins over the header, and a key that is missing or not a string leaves
 * the header to decide. Either way it is judged by the one rule below.
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
 *   - the per-address cap counts a relay as one address, however many users it serves;
 *   - the `meta` keys are believed only with `REGISTRY_ADAPTER_TRUST_META=1`, once the registry
 *     gateway sets each from the edge's header, replacing what the caller sent; it is the only
 *     caller that reaches the subscription path. A caller that reached this process another way
 *     could name its own.
 */
import type { IncomingMessage } from 'node:http';
import type { NextApiRequest } from 'next';
import type { RequestMeta } from '~/server/registry-adapter/protocol';
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
  /** The request's `meta` (`protocol.ts`), when it had one. */
  meta?: RequestMeta;
  /** The transport peer's address, without its port. */
  remoteAddress?: string;
};

/** The `meta` key each region header is read from, as the gateway names them. */
export const REGION_META_KEYS = {
  'cf-ipcountry': 'country',
  'cf-region-code': 'region',
} as const;

/**
 * Whether `meta` is believed at all (`REGISTRY_ADAPTER_TRUST_META=1`). Off until the gateway sets
 * every {@link REGION_META_KEYS} key from the edge's headers: before that, a relay passes on the
 * `meta` its caller sent, which would let a caller name its own country.
 */
export function metaTrusted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGISTRY_ADAPTER_TRUST_META === '1';
}

/**
 * `origin`'s headers with each region header replaced by its `meta` key, when that is a string,
 * and the names of the headers so replaced. Exported for the content-policy shadow
 * (`policy-shadow.ts`), which sends the service the same values this file judges.
 */
export function regionHeaders(origin: RequestOrigin): {
  headers: RequestOrigin['headers'];
  fromMeta: Set<string>;
} {
  const headers = { ...origin.headers };
  const fromMeta = new Set<string>();
  if (!metaTrusted()) return { headers, fromMeta };
  for (const [header, key] of Object.entries(REGION_META_KEYS)) {
    const value = origin.meta?.[key];
    if (typeof value === 'string') {
      headers[header] = value;
      fromMeta.add(header);
    }
  }
  return { headers, fromMeta };
}

/**
 * The edge's country codes that name no country: `XX`, no country known; `T1`, Tor. Exported for
 * scripts/content-policy-go-data.ts, which hands it to the Go content-policy service.
 */
export const NO_COUNTRY: ReadonlySet<string> = new Set(['XX', 'T1']);

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
 * The region decision for one request, as {@link regionLine} logs it:
 *   - `country`: the two-letter code judged, uppercase, or `none` when it names no country
 *     (`countryKnown`); a value that is not a code is never echoed;
 *   - `region`: the region code beside a known country, when it is one to three letters or
 *     digits (`NY`); otherwise `undefined`;
 *   - `source`: where the country value judged came from: `meta` when meta supplied it (only
 *     with {@link metaTrusted}) and nothing overrode it, even a value that names no country
 *     (`""`, `XX`); otherwise `header` when the value judged is non-empty (the `cf-ipcountry`
 *     header, or the `GB` that `x-isuk` sets, which overrides a different meta country), or
 *     `none` when it is missing or empty;
 *   - `restricted`: whether the request is held to SFW (see the file comment).
 */
export type RegionDecision = {
  country: string;
  region?: string;
  source: 'meta' | 'header' | 'none';
  restricted: boolean;
};

/** `origin`'s region decision at `at`; {@link regionRestricted} is its `restricted` field. */
/**
 * `region` with its country and region code trimmed and uppercased, and the full location code
 * rebuilt from them, as `getRegion` builds it. The one place this source normalises a region:
 * whether the country is known ({@link countryKnown}) and whether a region list names it are both
 * judged on this, so a value the edge padded or lowercased (` FR`, `gb\n`, `us` with `ny`) is held
 * by the lists exactly as its clean form is. Before this, `countryKnown` trimmed but the lists were
 * read untrimmed, so a padded country counted as known, matched no list, and was served
 * unrestricted. A value that is not a string (a repeated header) is left as it is: it names no
 * country.
 */
export function normalizeRegion(region: RegionInfo): RegionInfo {
  const clean = (v: string | null | undefined) =>
    typeof v === 'string' ? v.trim().toUpperCase() : v ?? null;
  const countryCode = clean(region.countryCode);
  const regionCode = clean(region.regionCode);
  return {
    countryCode,
    regionCode,
    fullLocationCode: countryCode && regionCode ? `${countryCode}:${regionCode}` : countryCode,
  };
}

export function describeRegion(origin: RequestOrigin, at: Date = new Date()): RegionDecision {
  const { headers, fromMeta } = regionHeaders(origin);
  const read = getRegion({ headers } as unknown as IncomingMessage);
  const raw = read.countryCode;
  // A country `getRegion` took from elsewhere (`x-isuk`) is the header's, even beside meta.
  let source: RegionDecision['source'] = 'none';
  if (fromMeta.has('cf-ipcountry') && raw === headers['cf-ipcountry']) source = 'meta';
  else if (typeof raw === 'string' && raw !== '') source = 'header';
  const region = normalizeRegion(read);
  if (!countryKnown(region)) return { country: 'none', source, restricted: true };
  const code = region.regionCode ?? '';
  return {
    country: region.countryCode as string,
    region: /^[A-Z0-9]{1,3}$/.test(code) ? code : undefined,
    source,
    restricted: isRegionRestricted(region, at) || isRegionBlocked(region, at),
  };
}

/**
 * Whether `origin` is held to SFW content at `at`: a request whose country cannot be told
 * (`countryKnown`), a region the site restricts to SFW, or one it blocks (see the file comment).
 */
export function regionRestricted(origin: RequestOrigin, at: Date = new Date()): boolean {
  return describeRegion(origin, at).restricted;
}

/**
 * The one log line for a subscription's region decision on `binding`: its country, region,
 * source and SFW hold, and nothing else of the request (no address, token or user).
 */
export function regionLine(binding: 'http' | 'grpc', d: RegionDecision): string {
  return (
    `subscription region: binding=${binding} country=${d.country} ` +
    `region=${d.region ?? 'none'} source=${d.source} restricted=${d.restricted}`
  );
}

/**
 * The line a subscription on `binding` logs as it starts: `origin`'s region decision, with the
 * SFW hold `restricted` actually applies (a binding's injected rule, when it has one).
 */
export function subscriptionRegionLine(
  binding: 'http' | 'grpc',
  origin: RequestOrigin,
  restricted: (origin: RequestOrigin) => boolean
): string {
  return regionLine(binding, { ...describeRegion(origin), restricted: restricted(origin) });
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
            '(blocked regions, and requests with no region, still are); set it as the site does',
        ]
      : [];
  return { info, warn };
}
