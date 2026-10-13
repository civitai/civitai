import { Resolver } from 'node:dns/promises';
import { env } from '~/env/server';
import {
  DEV_TUNNEL_HARD_SECONDS,
  getActiveDevTunnel,
} from '~/server/services/blocks/dev-tunnel.service';
import { isValidDevHost } from '~/server/services/blocks/dev-tunnel-session';

const QUERY_TIMEOUT_MS = 1_500;
/** Nameservers asked per check; each is asked in parallel and all of them have to agree. */
const MAX_SERVERS = 2;
const SERVERS_TTL_MS = 10 * 60_000;
/** How long a failed nameserver discovery is remembered, so an outage is not paid per request. */
const SERVERS_RETRY_MS = 15_000;
/** One log line per failure kind per window: a broken check fails on every poll of every page. */
const WARN_EVERY_MS = 15_000;
const PUBLISHED_MEMO_MAX = 1_000;
// A host is minted for one tunnel and never reused, so a positive answer holds for its whole life.
const PUBLISHED_MEMO_TTL_MS = DEV_TUNNEL_HARD_SECONDS * 1000;

// One try per query: the caller polls, so a retry here only delays the answer.
const newResolver = () => new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });

// Absolute, so the name can never be completed with a search domain.
const absolute = (name: string) => (name.endsWith('.') ? name : `${name}.`);

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/**
 * One address for each of the first nameservers of the zone `domain` sits in (it need not be the
 * zone apex). These names are long-lived, so the system resolver is safe for them.
 */
async function discoverServers(domain: string): Promise<string[]> {
  const system = newResolver();
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const names = await system.resolveNs(absolute(labels.slice(i).join('.'))).catch(() => []);
    const found = await Promise.all(
      names.slice(0, MAX_SERVERS).map((name) => system.resolve4(absolute(name)).catch(() => []))
    );
    const servers = found.flatMap((addresses) => addresses.slice(0, 1));
    if (servers.length) return servers;
  }
  return [];
}

const lastWarnedAt = new Map<string, number>();
function warnCheckFailed(detail: { code?: string; error?: string }) {
  const kind = detail.code ?? detail.error ?? '';
  if (Date.now() - (lastWarnedAt.get(kind) ?? 0) < WARN_EVERY_MS) return;
  lastWarnedAt.set(kind, Date.now());
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ event: 'app-blocks.dev-tunnel.dns-ready.error', ...detail }));
}

let serversCache: { domain: string; servers: Promise<string[]>; expiresAt: number } | null = null;

/** Host → when its positive answer stops being trusted. A negative is never stored. */
const publishedUntil = new Map<string, number>();

function rememberPublished(host: string) {
  publishedUntil.set(host, Date.now() + PUBLISHED_MEMO_TTL_MS);
  if (publishedUntil.size > PUBLISHED_MEMO_MAX) {
    const oldest = publishedUntil.keys().next().value;
    if (oldest !== undefined) publishedUntil.delete(oldest);
  }
}

function seenPublished(host: string): boolean {
  const until = publishedUntil.get(host);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  publishedUntil.delete(host);
  return false;
}

/** TEST-ONLY: forget the cached nameserver addresses, the hosts seen published and the log throttle. */
export function __resetDevTunnelDnsServersForTest(): void {
  serversCache = null;
  publishedUntil.clear();
  lastWarnedAt.clear();
}

function authoritativeServers(domain: string): Promise<string[]> {
  if (serversCache && serversCache.domain === domain && serversCache.expiresAt > Date.now())
    return serversCache.servers;
  const entry = {
    domain,
    servers: discoverServers(domain).catch(() => []),
    expiresAt: Date.now() + SERVERS_TTL_MS,
  };
  serversCache = entry;
  void entry.servers.then((servers) => {
    if (servers.length) return;
    entry.expiresAt = Date.now() + SERVERS_RETRY_MS;
    warnCheckFailed({ error: 'no authoritative nameserver found' });
  });
  return entry.servers;
}

/** Whether one nameserver has the name: `null` when it could not be asked. */
async function serverHasName(server: string, name: string): Promise<boolean | null> {
  const resolver = newResolver();
  resolver.setServers([server]);
  try {
    const addresses = await resolver.resolve4(name).catch((error) => {
      if (errorCode(error) !== 'ENODATA') throw error;
      return [];
    });
    if (addresses.length) return true;
    // An alias answers an address query with no addresses, so it needs asking for by type.
    return (await resolver.resolveCname(name)).length > 0;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTFOUND' || code === 'ENODATA') return false;
    warnCheckFailed({
      code: typeof code === 'string' ? code : undefined,
      error: (error as Error)?.message,
    });
    return null;
  }
}

/**
 * Whether `host`'s DNS record is published, asked of its zone's AUTHORITATIVE nameservers only.
 * A recursive resolver (the system one included) caches a miss for the zone's negative TTL and
 * keeps answering "not there" after the record exists.
 *
 * Never throws. Ready means no nameserver that answered lacks the name, so it is also ready when
 * none could be asked: the check only narrows a race, and skipping it is the behaviour from before
 * it existed.
 *
 * Without `APPS_DEV_TUNNEL_INGRESS_TARGET` this deployment publishes no record per tunnel, so
 * there is nothing to wait for and the answer is always `true`.
 */
export async function isDevTunnelHostPublished(host: string): Promise<boolean> {
  if (!env.APPS_DEV_TUNNEL_INGRESS_TARGET) return true;
  if (!isValidDevHost(host, env.APPS_DOMAIN)) return false;
  if (seenPublished(host)) return true;
  const servers = await authoritativeServers(env.APPS_DOMAIN);
  const answers = await Promise.all(servers.map((server) => serverHasName(server, absolute(host))));
  if (answers.includes(false)) return false;
  if (answers.includes(true)) rememberPublished(host);
  return true;
}

export type DevTunnelDnsReadiness = { active: false } | { active: true; ready: boolean };

/** Only the caller's own session host is checked, never a client-supplied name. */
export async function getDevTunnelDnsReadiness(
  userId: number,
  blockId: string
): Promise<DevTunnelDnsReadiness> {
  const tunnel = await getActiveDevTunnel(userId, blockId);
  if (!tunnel) return { active: false };
  return { active: true, ready: await isDevTunnelHostPublished(tunnel.host) };
}
