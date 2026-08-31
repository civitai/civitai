import { createRedisCacheBuilder, createSysRedisCacheBuilder } from '@civitai/redis';
import { getRedis, getSysRedis } from '$lib/server/redis';

// Read-through Redis caches for this app, namespaced under `cs:` (creator-studio). The cache mechanics
// (single-flight, TTL jitter, fail-open, named-args-as-key) live in `@civitai/redis`; here we just bind them to
// the app's client shims. Define a cache with `createCache({ name, fetch, ttlSeconds })` and call `.get(args)`.
export const createCache = createRedisCacheBuilder({ getClient: getRedis, prefix: 'cs' });

// Same, on the sys client — for anything that must live in the system redis instance.
export const createSysCache = createSysRedisCacheBuilder({ getClient: getSysRedis, prefix: 'cs' });
