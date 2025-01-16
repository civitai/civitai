import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import { EntityAccessWithKey, getUserEntityAccess } from './common.service';

const PRIVATE_RESOURCE_ACCESS_CACHE_EXPIRY = 60 * 60 * 4;

// #region [private resource access]
export async function getPrivateEntityAccessForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}) {
  const cacheKey =
    `${REDIS_KEYS.USER.BASE}:${userId}:${REDIS_SUB_KEYS.USER.PRIVATE_ENTITY_ACCESS}` as const;

  const cachedEntities = await redis.get(cacheKey);
  if (cachedEntities && !refreshCache) return JSON.parse(cachedEntities) as EntityAccessWithKey[];
  if (refreshCache) await redis.del(cacheKey);

  const entities = await getUserEntityAccess({ userId });
  await redis.set(cacheKey, JSON.stringify(entities), {
    EX: PRIVATE_RESOURCE_ACCESS_CACHE_EXPIRY,
  });

  return entities;
}
