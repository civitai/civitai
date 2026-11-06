import type { IncomingHttpHeaders } from 'http';
import semver from 'semver';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { SITE_ALERTS_VERSION_FIELD } from '~/shared/constants/site-alert.constants';

// The CLIENT hash is a single global key (forced-client-update version/date
// gating, and the site alerts version), identical for every user and procedure.
// needsUpdate runs on EVERY web-client tRPC procedure, and tRPC batches multiple
// procedures per HTTP request, so an uncached hGetAll here is ~1 sysRedis
// round-trip PER PROCEDURE across all web traffic. Cache it in-process with a
// short TTL: gating a "refresh your browser" banner tolerates a few seconds of
// staleness trivially, and this collapses thousands of reads/s into ~1 read /
// TTL / pod. Only successful reads are cached, so callers' fail-open behavior is
// preserved.
const CLIENT_CONFIG_TTL_MS = 5_000;
let clientConfigCache: { value: Record<string, string>; expiresAt: number } | null = null;

export async function getClientConfigCached(): Promise<Record<string, string>> {
  const now = Date.now();
  if (clientConfigCache && clientConfigCache.expiresAt > now) return clientConfigCache.value;
  // Wall-clock deadline so a stalled/half-open sysRedis can't park this hGetAll for
  // OS-keepalive minutes (the sys client has no socketTimeout, and a per-command
  // timeout can't abort a written command).
  const client = await withSysReadDeadline(sysRedis.hGetAll(REDIS_SYS_KEYS.CLIENT));
  clientConfigCache = { value: client, expiresAt: now + CLIENT_CONFIG_TTL_MS };
  return client;
}

/**
 * The last CLIENT hash read, expired or not, without touching Redis. For synchronous callers
 * (tRPC `responseMeta`); undefined until the first successful read on this pod.
 */
export function peekClientConfig(): Record<string, string> | undefined {
  return clientConfigCache?.value;
}

/**
 * Only an unexpired read. For decisions that must fail open the way `needsUpdate` does when
 * sysRedis is unreachable, rather than act on an old value.
 */
export function peekFreshClientConfig(): Record<string, string> | undefined {
  return clientConfigCache && clientConfigCache.expiresAt > Date.now()
    ? clientConfigCache.value
    : undefined;
}

export function readSiteAlertsVersion(client: Record<string, string | Buffer | undefined>) {
  const version = Number(decodeRedisString(client[SITE_ALERTS_VERSION_FIELD]));
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

/** 0 when this pod has not read the CLIENT hash yet, or no alert was ever saved. */
export function peekSiteAlertsVersion() {
  const client = peekClientConfig();
  return client ? readSiteAlertsVersion(client) : 0;
}

/** Whether this request's bundle is older than the version or date the CLIENT hash forces. */
export function clientNeedsUpdate(
  headers: IncomingHttpHeaders | undefined,
  client: Record<string, string>
) {
  const version = headers?.['x-client-version'] as string | undefined;
  const date = headers?.['x-client-date'] as string | undefined;
  const clientVersion = decodeRedisString(client.version);
  if (clientVersion) {
    if (!version || version === 'unknown') return true;
    return semver.lt(version, clientVersion);
  }
  if (client.date) {
    if (!date) return true;
    return new Date(Number(date)) < new Date(client.date);
  }
  return false;
}
