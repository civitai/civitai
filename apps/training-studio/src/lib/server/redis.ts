import { createSysRedis, type RedisSysClient } from '@civitai/redis';

// The shared system cluster — same instance the main app reads. Lazy: the builder eagerly connects, so a
// missing REDIS_SYS_URL fails on first use, not at boot. Only the sys client is needed (the orchestrator
// token get-or-mint cache); callers treat a redis failure as fail-open (mint fresh instead).
let sysClient: RedisSysClient | undefined;

export function getSysRedis(): RedisSysClient {
  if (!sysClient) sysClient = createSysRedis();
  return sysClient;
}
