import { NsfwLevel, TagEngagementType, TagType } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import { tagsNeedingReview } from '~/libs/tags';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { indexOfOr } from '~/utils/array-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('system-cache', 'green');

const SYSTEM_CACHE_EXPIRY = 60 * 60 * 4;
export async function getModerationTags() {
  const cachedTags = await redis.get(`system:moderation-tags-2`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string; nsfw: NsfwLevel }[];

  log('getting moderation tags');
  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.Moderation },
    select: { id: true, name: true, nsfw: true },
  });
  await redis.set(`system:moderation-tags`, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got moderation tags');
  return tags;
}

export async function getBlockedTags() {
  const cachedTags = await redis.get(`system:blocked-tags`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string; nsfw: NsfwLevel }[];
  const moderatedTags = await getModerationTags();
  const blockedTags = moderatedTags.filter((x) => x.nsfw === NsfwLevel.Blocked);
  await redis.set(`system:blocked-tags`, JSON.stringify(blockedTags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });
  return blockedTags;
}

/** gets tags we don't want to show to not-signed-in users */
export async function getSystemHiddenTags(): Promise<
  { id: number; name: string; nsfw?: NsfwLevel }[]
> {
  const cachedTags = await redis.get(`system:hidden-tags-2`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string; nsfw?: NsfwLevel }[];

  const moderation = await getModerationTags();
  const moderatedTags = moderation.map((x) => x.id);

  const hiddenTagsOfHiddenTags = await dbWrite.tagsOnTags.findMany({
    where: { fromTagId: { in: [...moderatedTags] } },
    select: { toTag: { select: { id: true, name: true } } },
  });

  const tags = uniqBy([...moderation, ...hiddenTagsOfHiddenTags.map((x) => x.toTag)], 'id');

  await redis.set(`system:hidden-tags`, JSON.stringify(tags), {
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

export async function addSystemPermission(permission: FeatureFlagKey, userIds: number | number[]) {
  userIds = Array.isArray(userIds) ? userIds : [userIds];
  const permissions = await getSystemPermissions();
  if (!permissions[permission]) permissions[permission] = [];
  permissions[permission] = [...new Set([...permissions[permission], ...userIds])];
  await redis.set(`system:permissions`, JSON.stringify(permissions));
}

export async function removeSystemPermission(
  permission: FeatureFlagKey,
  userIds: number | number[]
) {
  userIds = Array.isArray(userIds) ? userIds : [userIds];
  const permissions = await getSystemPermissions();
  if (!permissions[permission]) return;

  permissions[permission] = permissions[permission].filter(
    (x) => !(userIds as number[]).includes(x)
  );
  await redis.set(`system:permissions`, JSON.stringify(permissions));
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

export async function getHomeExcludedTags() {
  const cachedTags = await redis.get(`system:home-excluded-tags`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting home excluded tags');
  const tags = await dbWrite.tag.findMany({
    where: { name: { in: ['1girl', 'anime', 'female', 'woman', 'clothing'] } },
    select: { id: true, name: true },
  });
  await redis.set(`system:home-excluded-tags`, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got home excluded tags');
  return tags;
}
