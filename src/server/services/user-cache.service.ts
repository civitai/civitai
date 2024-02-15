import { redis } from '~/server/redis/client';
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
  const cachedEntities = await redis.get(`user:${userId}:private-entity-access`);
  if (cachedEntities && !refreshCache) return JSON.parse(cachedEntities) as EntityAccessWithKey[];
  if (refreshCache) await redis.del(`user:${userId}:private-entity-access`);

  const entities = await getUserEntityAccess({ userId });
  await redis.set(`user:${userId}:private-entity-access`, JSON.stringify(entities), {
    EX: PRIVATE_RESOURCE_ACCESS_CACHE_EXPIRY,
  });

  return entities;
}
