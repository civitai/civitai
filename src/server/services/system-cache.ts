import { TagType } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('system-cache', 'green');

const SYSTEM_CACHE_EXPIRY = 60 * 60 * 4;
export async function getModerationTags() {
  const cachedTags = await redis.get(`system:moderation-tags`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting moderation tags');
  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.Moderation },
    select: { id: true, name: true },
  });
  await redis.set(`system:moderation-tags`, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got moderation tags');
  return tags;
}

export async function getSystemTags() {
  const cachedTags = await redis.get(`system:system-tags`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting system tags');
  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.System },
    select: { id: true, name: true },
  });
  await redis.set(`system:system-tags`, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got system tags');
  return tags;
}
