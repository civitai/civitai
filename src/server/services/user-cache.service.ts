import {
  ModelEngagementType,
  TagEngagementType,
  TagType,
  UserEngagementType,
} from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';

const HIDDEN_CACHE_EXPIRY = 60 * 60 * 24;

// #region [hidden tags]
async function getModerationTags() {
  const cachedTags = await redis.get(`system:moderation-tags`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.Moderation },
    select: { id: true, name: true },
  });
  await redis.set(`system:moderation-tags`, JSON.stringify(tags), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  return tags;
}

async function getHiddenTags(userId: number) {
  const tags = await dbWrite.tagEngagement.findMany({
    where: { userId, type: { in: [TagEngagementType.Hide, TagEngagementType.Allow] } },
    select: { tag: { select: { id: true, name: true } }, type: true },
  });

  const moderationTags = await getModerationTags();
  const hiddenTags = moderationTags.map((x) => x.id);
  for (const { tag, type } of tags) {
    if (type === TagEngagementType.Hide) hiddenTags.push(tag.id);
    else if (type === TagEngagementType.Allow) {
      const i = hiddenTags.findIndex((id) => id === tag.id);
      hiddenTags.splice(i, 1);
    }
  }

  return hiddenTags;
}

export async function getHiddenTagsForUser({
  userId,
  refreshCache,
}: {
  userId: number;
  refreshCache?: boolean;
}) {
  const cachedTags = await redis.get(`user:${userId}:hidden-tags`);
  if (cachedTags && !refreshCache) return JSON.parse(cachedTags) as number[];
  if (refreshCache) await redis.del(`user:${userId}:hidden-tags`);

  const hiddenTags = await getHiddenTags(userId);
  await redis.set(`user:${userId}:hidden-tags`, JSON.stringify(hiddenTags), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  return hiddenTags;
}

export async function refreshHiddenTagsForUser({ userId }: { userId: number }) {
  await redis.del(`user:${userId}:hidden-tags`);
}
// #endregion

// #region [hidden users]
async function getHiddenUsers(userId: number) {
  const users = await dbWrite.userEngagement.findMany({
    where: { userId, type: UserEngagementType.Hide },
    select: { user: { select: { id: true, username: true } } },
  });

  const hiddenUsers = users?.map((x) => x.user.id) ?? [];
  return hiddenUsers;
}

export async function getHiddenUsersForUser({
  userId,
  refreshCache,
}: {
  userId: number;
  refreshCache?: boolean;
}) {
  const cachedUsers = await redis.get(`user:${userId}:hidden-users`);
  if (cachedUsers && !refreshCache) return JSON.parse(cachedUsers) as number[];
  if (refreshCache) await redis.del(`user:${userId}:hidden-users`);

  const hiddenUsers = await getHiddenUsers(userId);
  await redis.set(`user:${userId}:hidden-users`, JSON.stringify(hiddenUsers), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  return hiddenUsers;
}

export async function refreshHiddenUsersForUser({ userId }: { userId: number }) {
  await redis.del(`user:${userId}:hidden-users`);
}
// #endregion

// #region [hidden models]
async function getHiddenModels(userId: number) {
  const models = await dbWrite.modelEngagement.findMany({
    where: { userId, type: ModelEngagementType.Hide },
    select: { model: { select: { id: true } } },
  });

  const hiddenModels = models?.map((x) => x.model.id) ?? [];
  return hiddenModels;
}

export async function getHiddenModelsForUser({
  userId,
  refreshCache,
}: {
  userId: number;
  refreshCache?: boolean;
}) {
  const cachedModels = await redis.get(`user:${userId}:hidden-models`);
  if (cachedModels && !refreshCache) return JSON.parse(cachedModels) as number[];
  if (refreshCache) await redis.del(`user:${userId}:hidden-models`);

  const hiddenModels = await getHiddenModels(userId);
  await redis.set(`user:${userId}:hidden-models`, JSON.stringify(hiddenModels), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  return hiddenModels;
}

export async function refreshHiddenModelsForUser({ userId }: { userId: number }) {
  await redis.del(`user:${userId}:hidden-models`);
}
// #endregion
