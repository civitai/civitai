import { createSysRedis, type RedisSysClient } from '@civitai/redis';

let sysClient: RedisSysClient | undefined;

export function getSysRedis(): RedisSysClient {
  if (!sysClient) sysClient = createSysRedis();
  return sysClient;
}
