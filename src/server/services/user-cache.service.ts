import {
  ModelEngagementType,
  TagEngagementType,
  TagType,
  UserEngagementType,
} from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { createLogger } from '~/utils/logging';

const HIDDEN_CACHE_EXPIRY = 60 * 60 * 4;
const log = createLogger('user-cache', 'green');

// #region [hidden tags]
async function getModerationTags() {
  log('getting moderation tags');
  const cachedTags = await redis.get(`system:moderation-tags`);
  if (cachedTags) return JSON.parse(cachedTags) as { id: number; name: string }[];

  const tags = await dbWrite.tag.findMany({
    where: { type: TagType.Moderation },
    select: { id: true, name: true },
  });
  await redis.set(`system:moderation-tags`, JSON.stringify(tags), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  log('got moderation tags');
  return tags;
}

async function getHiddenTags(userId: number) {
  log(`reloading hidden tags for user: ${userId}`);
  const tags = await dbWrite.tagEngagement.findMany({
    where: { userId, type: { in: [TagEngagementType.Hide, TagEngagementType.Allow] } },
    select: { tag: { select: { id: true } }, type: true },
  });
  const { showNsfw } =
    (await dbWrite.user.findUnique({
      where: { id: userId },
      select: { showNsfw: true },
    })) ?? {};

  const moderationTags = await getModerationTags();
  const hiddenTags = moderationTags.map((x) => x.id);

  // If NSFW is disabled, also add additional civitai hidden tags
  if (!showNsfw) {
    const civitaiHiddenTags = await getHiddenTagsForUser({ userId: -1 });
    hiddenTags.push(...civitaiHiddenTags);
  }

  for (const { tag, type } of tags) {
    if (type === TagEngagementType.Hide) hiddenTags.push(tag.id);
    else if (showNsfw && type === TagEngagementType.Allow) {
      const i = hiddenTags.findIndex((id) => id === tag.id);
      hiddenTags.splice(i, 1);
    }
  }

  log(`reloaded hidden tags for user: ${userId}`);
  return hiddenTags;
}

export async function getHiddenTagsForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}) {
  log(`getting hidden tags for user: ${userId}`);
  const cachedTags = await redis.get(`user:${userId}:hidden-tags`);
  if (cachedTags && !refreshCache) {
    log(`got hidden tags for user: ${userId} (cached)`);
    return JSON.parse(cachedTags) as number[];
  }
  if (refreshCache) await redis.del(`user:${userId}:hidden-tags`);

  const hiddenTags = await getHiddenTags(userId);
  await redis.set(`user:${userId}:hidden-tags`, JSON.stringify(hiddenTags), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  log(`got hidden tags for user: ${userId}`);
  return hiddenTags;
}

export async function refreshHiddenTagsForUser({ userId }: { userId: number }) {
  console.log('refreshing hidden tags for user', userId);
  await redis.del(`user:${userId}:hidden-tags`);
}
// #endregion

// #region [hidden users]
async function getHiddenUsers(userId: number) {
  const users = await dbWrite.userEngagement.findMany({
    where: { userId, type: UserEngagementType.Hide },
    select: { targetUser: { select: { id: true } } },
  });

  const hiddenUsers = users?.map((x) => x.targetUser.id) ?? [];
  return hiddenUsers;
}

export async function getHiddenUsersForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
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
  console.log('refreshing hidden users for user', userId);
  await redis.del(`user:${userId}:hidden-users`);
}
// #endregion

// #region [hidden models]
async function getHiddenModels(userId: number) {
  const models = await dbWrite.modelEngagement.findMany({
    where: { userId, type: ModelEngagementType.Hide },
    select: { model: { select: { id: true } } },
  });

  const hiddenTags = await getHiddenTagsForUser({ userId });
  const votedHideModels = await dbWrite.tagsOnModelsVote.findMany({
    where: { userId, tagId: { in: hiddenTags }, vote: { gt: 0 } },
    select: { modelId: true },
  });

  const hiddenModels = [
    ...new Set([
      ...(models?.map((x) => x.model.id) ?? []),
      ...(votedHideModels?.map((x) => x.modelId) ?? []),
    ]),
  ];
  return hiddenModels;
}

export async function getHiddenModelsForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
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
  console.log('refreshing hidden models for user', userId);
  await redis.del(`user:${userId}:hidden-models`);
}
// #endregion

// #region [hidden images]
async function getHiddenImages(userId: number) {
  const hiddenTags = await getHiddenTagsForUser({ userId });
  const votedHideImages = await dbWrite.tagsOnImageVote.findMany({
    where: { userId, tagId: { in: hiddenTags }, vote: { gt: 0 } },
    select: { imageId: true },
  });

  const hiddenImages = [...new Set(votedHideImages?.map((x) => x.imageId) ?? [])];
  console.log(hiddenImages);
  return hiddenImages;
}

export async function getHiddenImagesForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}) {
  const cachedImages = await redis.get(`user:${userId}:hidden-images`);
  if (cachedImages && !refreshCache) return JSON.parse(cachedImages) as number[];
  if (refreshCache) await redis.del(`user:${userId}:hidden-images`);

  const hiddenImages = await getHiddenImages(userId);
  await redis.set(`user:${userId}:hidden-images`, JSON.stringify(hiddenImages), {
    EX: HIDDEN_CACHE_EXPIRY,
  });

  return hiddenImages;
}

export async function refreshHiddenImagesForUser({ userId }: { userId: number }) {
  console.log('refreshing hidden images for user', userId);
  await redis.del(`user:${userId}:hidden-images`);
}
// #endregion

export async function getAllHiddenForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}) {
  const [tags, users, models, images] = await Promise.all([
    getHiddenTagsForUser({ userId, refreshCache }),
    getHiddenUsersForUser({ userId, refreshCache }),
    getHiddenModelsForUser({ userId, refreshCache }),
    getHiddenImagesForUser({ userId, refreshCache }),
  ]);

  return { tags, users, models, images };
}

export async function refreshAllHiddenForUser({ userId }: { userId: number }) {
  log(`refreshing all hidden for user ${userId}`);
  await Promise.all([
    refreshHiddenTagsForUser({ userId }),
    refreshHiddenUsersForUser({ userId }),
    refreshHiddenModelsForUser({ userId }),
    refreshHiddenImagesForUser({ userId }),
  ]);
}

export const userCache = (userId?: number) => ({
  hidden: {
    all: {
      get: (refreshCache = false) => getAllHiddenForUser({ userId, refreshCache }),
      refresh: () => userId && refreshAllHiddenForUser({ userId }),
    },
    tags: {
      get: (refreshCache = false) => getHiddenTagsForUser({ userId, refreshCache }),
      refresh: () => userId && refreshHiddenTagsForUser({ userId }),
    },
    users: {
      get: (refreshCache = false) => getHiddenUsersForUser({ userId, refreshCache }),
      refresh: () => userId && refreshHiddenUsersForUser({ userId }),
    },
    models: {
      get: (refreshCache = false) => getHiddenModelsForUser({ userId, refreshCache }),
      refresh: () => userId && refreshHiddenModelsForUser({ userId }),
    },
    images: {
      get: (refreshCache = false) => getHiddenImagesForUser({ userId, refreshCache }),
      refresh: () => userId && refreshHiddenImagesForUser({ userId }),
    },
  },
});
