import { TagsOnTagsType, TagType } from '@prisma/client';
import { tagsNeedingReview } from '~/libs/tags';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { indexOfOr } from '~/utils/array-helpers';
import { createLogger } from '~/utils/logging';
import { NsfwLevel } from '~/server/common/enums';
import { isDefined } from '~/utils/type-guards';

const log = createLogger('system-cache', 'green');

const SYSTEM_CACHE_EXPIRY = 60 * 60 * 4;

export type SystemModerationTag = {
  id: number;
  name: string;
  nsfwLevel: NsfwLevel;
  parentId?: number;
};
export async function getModeratedTags(): Promise<SystemModerationTag[]> {
  const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.MODERATED_TAGS);
  if (cachedTags) return JSON.parse(cachedTags);

  log('getting moderation tags');
  const tags = await dbRead.tag.findMany({
    where: { nsfwLevel: { not: NsfwLevel.PG } },
    select: { id: true, name: true, nsfwLevel: true },
  });

  const tagsOnTags = await dbRead.tagsOnTags.findMany({
    where: { fromTagId: { in: tags.map((x) => x.id) }, type: 'Parent' },
    select: { fromTagId: true, toTag: { select: { id: true, name: true } } },
  });

  const normalizedTagsOnTags = tagsOnTags
    .map(({ fromTagId, toTag }) => {
      const parentTag = tags.find((x) => x.id === fromTagId);
      if (!parentTag) return null;
      return { ...toTag, nsfwLevel: parentTag.nsfwLevel, parentId: fromTagId };
    })
    .filter(isDefined);

  const combined: SystemModerationTag[] = [...tags, ...normalizedTagsOnTags];

  await redis.set(REDIS_KEYS.SYSTEM.MODERATED_TAGS, JSON.stringify(combined), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got moderation tags');
  return combined;
}

export type TagRule = {
  fromId: number;
  toId: number;
  fromTag: string;
  toTag: string;
  type: TagsOnTagsType;
  createdAt: Date;
};
export async function getTagRules() {
  const cached = await redis.get(REDIS_KEYS.SYSTEM.TAG_RULES);
  if (cached) return JSON.parse(cached) as TagRule[];

  log('getting tag rules');
  const rules = await dbWrite.$queryRaw<TagRule[]>`
    SELECT
      "fromTagId" as "fromId",
      "toTagId" as "toId",
      f."name" as "fromTag",
      t."name" as "toTag",
      tot.type,
      tot."createdAt"
    FROM "TagsOnTags" tot
    JOIN "Tag" f ON f."id" = tot."fromTagId"
    JOIN "Tag" t ON t."id" = tot."toTagId"
    WHERE tot.type IN ('Replace', 'Append')
  `;
  await redis.set(REDIS_KEYS.SYSTEM.TAG_RULES, JSON.stringify(rules), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got tag rules');
  return rules;
}

export async function getSystemTags() {
  const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.SYSTEM_TAGS);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting system tags');
  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.System },
    select: { id: true, name: true },
  });
  await redis.set(REDIS_KEYS.SYSTEM.SYSTEM_TAGS, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got system tags');
  return tags;
}

export async function getSystemPermissions(): Promise<Record<string, number[]>> {
  const cachedPermissions = await redis.get(REDIS_KEYS.SYSTEM.PERMISSIONS);
  if (cachedPermissions) return JSON.parse(cachedPermissions);

  return {};
}

export async function addSystemPermission(permission: FeatureFlagKey, userIds: number | number[]) {
  userIds = Array.isArray(userIds) ? userIds : [userIds];
  const permissions = await getSystemPermissions();
  if (!permissions[permission]) permissions[permission] = [];
  permissions[permission] = [...new Set([...permissions[permission], ...userIds])];
  await redis.set(REDIS_KEYS.SYSTEM.PERMISSIONS, JSON.stringify(permissions));
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
  await redis.set(REDIS_KEYS.SYSTEM.PERMISSIONS, JSON.stringify(permissions));
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
  const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.TAGS_NEEDING_REVIEW);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting tags needing review');
  const tags = await dbWrite.tag.findMany({
    where: { name: { in: tagsNeedingReview } },
    select: { id: true, name: true },
  });

  await redis.set(REDIS_KEYS.SYSTEM.TAGS_NEEDING_REVIEW, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got tags needing review');
  return tags;
}

export async function getHomeExcludedTags() {
  const cachedTags = await redis.get(REDIS_KEYS.SYSTEM.HOME_EXCLUDED_TAGS);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  log('getting home excluded tags');
  const tags = await dbWrite.tag.findMany({
    where: { name: { in: ['woman'] } },
    select: { id: true, name: true },
  });
  await redis.set(REDIS_KEYS.SYSTEM.HOME_EXCLUDED_TAGS, JSON.stringify(tags), {
    EX: SYSTEM_CACHE_EXPIRY,
  });

  log('got home excluded tags');
  return tags;
}

export async function setLiveNow(isLive: boolean) {
  await redis.set(REDIS_KEYS.LIVE_NOW, isLive ? 'true' : 'false');
}
export async function getLiveNow() {
  const cachedLiveNow = await redis.get(REDIS_KEYS.LIVE_NOW);
  return cachedLiveNow === 'true';
}
