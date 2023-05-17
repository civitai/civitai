import { TagType } from '@prisma/client';
import { tagsNeedingReview } from '~/libs/tags';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { indexOfOr } from '~/utils/array-helpers';
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

export async function getAllowedAnonymousTags() {
  const cachedTags = await redis.get(`system:anonymous-tags`);
  return JSON.parse(cachedTags ?? '[]') as number[];
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

export async function getSystemPermissions(): Promise<Record<string, number[]>> {
  const cachedPermissions = await redis.get(`system:permissions`);
  if (cachedPermissions) return JSON.parse(cachedPermissions);

  return {};
}

const colorPriority = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'brown',
  'grey',
];

export async function getCategoryTags(type: 'image' | 'model' | 'post' | 'article') {
  let categories: TypeCategory[] | undefined;
  const categoriesCache = await redis.get(`system:categories:${type}`);
  if (categoriesCache) categories = JSON.parse(categoriesCache);

  if (!categories) {
    const systemTags = await getSystemTags();
    const categoryTag = systemTags.find((t) => t.name === `${type} category`);
    if (!categoryTag) throw new Error(`${type} category tag not found`);
    const categoriesRaw = await dbWrite.tag.findMany({
      where: { fromTags: { some: { fromTagId: categoryTag.id } } },
      select: { id: true, name: true, color: true, adminOnly: true },
    });
    categories = categoriesRaw
      .map((c) => ({
        id: c.id,
        name: c.name,
        adminOnly: c.adminOnly,
        priority: indexOfOr(colorPriority, c.color ?? 'grey', colorPriority.length),
      }))
      .sort((a, b) => a.priority - b.priority);
    if (categories.length) await redis.set(`system:categories:${type}`, JSON.stringify(categories));
  }

  return categories;
}

export async function getTagsNeedingReview() {
  const cachedTags = await redis.get(`system:tags-needing-review`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting tags needing review');
  const tags = await dbWrite.tag.findMany({
    where: { name: { in: tagsNeedingReview } },
    select: { id: true, name: true },
  });

  await redis.set(`system:tags-needing-review`, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got tags needing review');
  return tags;
}
