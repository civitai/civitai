import { Resolver, resolve4, resolveNs } from 'node:dns/promises';
import { env } from '~/env/server';
import { getActiveDevTunnel } from '~/server/services/blocks/dev-tunnel.service';
import { isValidDevHost } from '~/server/services/blocks/dev-tunnel-session';

/**
 * Whether a dev-tunnel host's DNS record exists yet. The record is published some time after the
 * tunnel is minted, and a browser that looks the name up first caches the miss for the zone's
 * negative TTL, so nothing may hand the host to a browser until this says it is there.
 *
 * 🔴 The host is asked of the zone's AUTHORITATIVE nameservers only. A recursive resolver (the
 * system one included) caches the same miss and would keep answering "not there" long after the
 * record exists.
 */

type HostResolver = Pick<Resolver, 'setServers' | 'resolve4' | 'resolveCname'>;

export type DevTunnelDnsDeps = {
  /** NS names of a zone. Long-lived records, so the system resolver is safe for these. */
  resolveNs: (zone: string) => Promise<string[]>;
  /** Addresses of one nameserver, again through the system resolver. */
  resolveNsAddress: (name: string) => Promise<string[]>;
  /** A resolver with no servers of its own choosing; it is pointed at the authoritative ones. */
  createResolver: () => HostResolver;
  now: () => number;
};

const QUERY_TIMEOUT_MS = 1_500;
/** Each server costs one timeout when the nameservers are unreachable. */
const MAX_SERVERS = 2;
const SERVERS_TTL_MS = 10 * 60_000;

const defaultDeps: DevTunnelDnsDeps = {
  resolveNs: (zone) => resolveNs(zone),
  resolveNsAddress: (name) => resolve4(name),
  createResolver: () => new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 }),
  now: () => Date.now(),
};

let serversCache: { domain: string; servers: string[]; expiresAt: number } | null = null;

/** TEST-ONLY: forget the cached nameserver addresses. */
export function __resetDevTunnelDnsServersForTest(): void {
  serversCache = null;
}

// A trailing dot makes the name absolute. Without it the resolver applies the host's search
// domains first, and those queries go to servers that are not authoritative for them.
const absolute = (name: string) => (name.endsWith('.') ? name : `${name}.`);

/** Addresses of the nameservers for the zone `domain` sits in (it need not be the zone apex). */
async function authoritativeServers(domain: string, deps: DevTunnelDnsDeps): Promise<string[]> {
  if (serversCache && serversCache.domain === domain && serversCache.expiresAt > deps.now())
    return serversCache.servers;
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const names = await deps.resolveNs(absolute(labels.slice(i).join('.'))).catch(() => []);
    if (!names.length) continue;
    const found = await Promise.all(
      names
        .slice(0, MAX_SERVERS)
        .map((name) => deps.resolveNsAddress(absolute(name)).catch(() => []))
    );
    const servers = found.flat().slice(0, MAX_SERVERS);
    if (!servers.length) continue;
    serversCache = { domain, servers, expiresAt: deps.now() + SERVERS_TTL_MS };
    return servers;
  }
  return [];
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/**
 * True once `host` has an address (or alias) record at its zone's authoritative nameservers.
 * Never throws: anything short of a positive answer is `false`.
 *
 * Without `APPS_DEV_TUNNEL_INGRESS_TARGET` this deployment publishes no record per tunnel (local
 * and preview environments), so there is nothing to wait for and the answer is always `true`.
 */
export async function isDevTunnelHostPublished(
  host: string,
  deps: DevTunnelDnsDeps = defaultDeps
): Promise<boolean> {
  if (!env.APPS_DEV_TUNNEL_INGRESS_TARGET) return true;
  if (!isValidDevHost(host, env.APPS_DOMAIN)) return false;
  try {
    const servers = await authoritativeServers(env.APPS_DOMAIN, deps);
    if (!servers.length) throw new Error('no authoritative nameserver');
    const resolver = deps.createResolver();
    resolver.setServers(servers);
    const name = absolute(host);
    try {
      return (await resolver.resolve4(name)).length > 0;
    } catch (error) {
      // The name exists without an address of its own: an alias the server does not chase.
      if (errorCode(error) !== 'ENODATA') throw error;
      return (await resolver.resolveCname(name)).length > 0;
    }
  } catch (error) {
    const code = errorCode(error);
    // "No such name" is the expected answer while the record is pending; anything else means the
    // check itself is broken, which would otherwise look identical from the outside.
    if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'app-blocks.dev-tunnel.dns-ready.error',
          code: typeof code === 'string' ? code : undefined,
          error: (error as Error)?.message,
        })
      );
    }
    return false;
  }
}

export type DevTunnelDnsReadiness = { active: false } | { active: true; ready: boolean };

/**
 * DNS readiness of the caller's own live tunnel for `blockId`. The host checked comes only from
 * that session record, so this can never be used to look up a name of the caller's choosing.
 */
export async function getDevTunnelDnsReadiness(
  userId: number,
  blockId: string,
  deps: DevTunnelDnsDeps = defaultDeps
): Promise<DevTunnelDnsReadiness> {
  const tunnel = await getActiveDevTunnel(userId, blockId);
  if (!tunnel) return { active: false };
  return { active: true, ready: await isDevTunnelHostPublished(tunnel.host, deps) };
}
