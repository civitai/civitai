import {
  createCacheRedis,
  createSysRedis,
  ensureClientOpen,
  type RedisCacheClient,
  type RedisSysClient,
} from '@civitai/redis';
import { env } from '$env/dynamic/private';
import type { EvalCapableClient } from './oauth/redis-atomic';

// The hub's two Redis clients, each lazy and memoized HERE so the whole app shares ONE cache + ONE sys
// connection (the registry + session producer both go through getSysRedis). Built on first use, never at
// module-load, so `vite build` doesn't connect. We use the single-purpose factories (createCacheRedis /
// createSysRedis) so each call builds ONLY the client it needs — `createRedisClients` would build and
// connect both. Returns null when the relevant URL isn't configured, so callers degrade (rate-limit fails
// open, blocklist falls back to the DB, registry → no-op).
//
// The memo is never replaced: a client that reaches the closed state is reopened IN PLACE
// (ensureClientOpen), because @civitai/redis binds its self-heal watchdog and topology refresh to the
// first client it builds, so a replacement would run unwatched.

let _redis: RedisCacheClient | null | undefined;

export function getRedis(): RedisCacheClient | null {
  if (_redis === undefined) _redis = env.REDIS_URL ? createCacheRedis() : null;
  if (_redis) ensureClientOpen(_redis, 'cache');
  return _redis;
}

let _sysRedis: RedisSysClient | null | undefined;

// The SYSTEM redis — separate instance from the cache redis. Used by the session producer (permissions
// map) and the session registry (revocation). Null when REDIS_SYS_URL isn't configured.
export function getSysRedis(): RedisSysClient | null {
  if (_sysRedis === undefined) _sysRedis = env.REDIS_SYS_URL ? createSysRedis() : null;
  if (_sysRedis) ensureClientOpen(_sysRedis, 'sys');
  return _sysRedis;
}

/** Run a Lua script on the sys redis (its typed facade doesn't expose `eval`). Null when it isn't configured. */
export async function evalSys(script: string, keys: string[], args: string[]): Promise<unknown> {
  const sys = getSysRedis() as unknown as EvalCapableClient | null;
  return sys ? sys.eval(script, { keys, arguments: args }) : null;
}
