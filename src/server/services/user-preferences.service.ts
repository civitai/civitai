import { ModelEngagementType, TagEngagementType, UserEngagementType } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { HiddenPreferencesInput } from '~/server/schema/user-preferences.schema';
import { getModerationTags } from '~/server/services/system-cache';
import { createLogger } from '~/utils/logging';
import { removeEmpty } from '~/utils/object-helpers';

const HIDDEN_CACHE_EXPIRY = 60 * 60 * 4;
const log = createLogger('user-preferences', 'green');

const getModerated = async () => {
  const moderated = await getModerationTags();
  return moderated.map((x) => x.id);
};

function createUserCache<T>({
  // logLabel,
  key,
  callback,
}: {
  // logLabel: string;
  key: string;
  callback: (args: { userId: number }) => Promise<T>;
}) {
  const getCached = async ({
    userId = -1, // Default to civitai account
    refreshCache,
  }: {
    userId: number;
    refreshCache?: boolean;
  }) => {
    // log(`getting ${logLabel} for user: ${userId}`);
    const cachedTags = await redis.get(`user:${userId}:${key}`);
    if (cachedTags && !refreshCache) {
      // log(`got${logLabel} for user: ${userId} (cached)`);
      return JSON.parse(cachedTags) as T;
    }
    if (refreshCache) {
      // console.log('refreshing: ', `user:${userId}:${key}`);
      await redis.del(`user:${userId}:${key}`);
    }

    const data = await callback({ userId });

    await redis.set(`user:${userId}:${key}`, JSON.stringify(data), {
      EX: HIDDEN_CACHE_EXPIRY,
    });

    // log(`got ${logLabel} for user: ${userId}`);
    return data;
  };

  const refreshCache = async ({ userId }: { userId: number }) => {
    // log(`refreshing ${logLabel} for user`, userId);
    await redis.del(`user:${userId}:${key}`);
  };

  return {
    getCached,
    refreshCache,
  };
}

const HiddenTags = createUserCache({
  // logLabel: 'hidden tags',
  key: 'hidden-tags-2',
  callback: async ({ userId }) => {
    const tagEngagment = await dbWrite.tagEngagement.findMany({
      where: { userId, type: TagEngagementType.Hide },
      select: { tagId: true },
    });
    let hiddenTags = tagEngagment.map((x) => x.tagId);

    // todo - return as system tags
    // todo - also need to do hidden tags of hidden tags for user hidden tags
    // [...hiddenTagsOfHiddenTags, ...moderation Tags]
    // [...hiddenTagsOfHiddenTags, ...user hidden tags]
    if (userId === -1) {
      const moderatedTags = await getModerated();
      const hiddenTagsOfHiddenTags = await dbWrite.tagsOnTags.findMany({
        where: { fromTagId: { in: [...moderatedTags] } },
        select: { toTagId: true },
      });

      hiddenTags = [...new Set([...hiddenTags, ...hiddenTagsOfHiddenTags.map((x) => x.toTagId)])];
    }

    return hiddenTags;
  },
});

const HiddenImages = createUserCache({
  key: 'hidden-images-2',
  callback: async ({ userId }) =>
    (
      await dbWrite.imageEngagement.findMany({
        where: { userId, type: UserEngagementType.Hide },
        select: { imageId: true },
      })
    ).map((x) => x.imageId),
});

const ImplicitHiddenImages = createUserCache({
  key: 'hidden-images-implicit',
  callback: async ({ userId }) => {
    const hiddenTags = await HiddenTags.getCached({ userId });
    const moderatedTags = await getModerated();
    const allHiddenTags = [...new Set([...hiddenTags, ...moderatedTags])];

    const votedHideImages = await dbWrite.tagsOnImageVote.findMany({
      where: { userId, tagId: { in: allHiddenTags }, vote: { gt: 0 } },
      select: { imageId: true, tagId: true },
    });

    const hidden = votedHideImages
      .filter((x) => hiddenTags.includes(x.tagId))
      .map((x) => x.imageId);
    const moderated = votedHideImages
      .filter((x) => moderatedTags.includes(x.tagId))
      .map((x) => x.imageId);

    return {
      hidden,
      moderated,
    };
  },
});

const HiddenModels = createUserCache({
  key: 'hidden-models-2',
  callback: async ({ userId }) =>
    (
      await dbWrite.modelEngagement.findMany({
        where: { userId, type: UserEngagementType.Hide },
        select: { modelId: true },
      })
    ).map((x) => x.modelId),
});

const ImplicitHiddenModels = createUserCache({
  key: 'hidden-models-implicit',
  callback: async ({ userId }) => {
    const hiddenTags = await HiddenTags.getCached({ userId });
    const moderatedTags = await getModerated();
    const allHiddenTags = [...new Set([...hiddenTags, ...moderatedTags])];

    const votedHideModels = await dbWrite.tagsOnModelsVote.findMany({
      where: { userId, tagId: { in: allHiddenTags }, vote: { gt: 0 } },
      select: { modelId: true, tagId: true },
    });

    const hidden = votedHideModels
      .filter((x) => hiddenTags.includes(x.tagId))
      .map((x) => x.modelId);
    const moderated = votedHideModels
      .filter((x) => moderatedTags.includes(x.tagId))
      .map((x) => x.modelId);

    return {
      hidden,
      moderated,
    };
  },
});

const HiddenUsers = createUserCache({
  key: 'hidden-users',
  callback: async ({ userId }) =>
    (
      await dbWrite.userEngagement.findMany({
        where: { userId, type: UserEngagementType.Hide },
        select: { targetUserId: true },
      })
    ).map((x) => x.targetUserId),
});

export async function getAllHiddenForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}): Promise<HiddenPreferencesInput> {
  const [moderatedTags, hiddenTags, images, models, users] = await Promise.all([
    getModerated(),
    HiddenTags.getCached({ userId, refreshCache }),
    HiddenImages.getCached({ userId, refreshCache }),
    HiddenModels.getCached({ userId, refreshCache }),
    HiddenUsers.getCached({ userId, refreshCache }),
  ]);

  // these two are dependent on the values from HiddenTags
  const [implicitImages, implicitModels] = await Promise.all([
    ImplicitHiddenImages.getCached({ userId, refreshCache }),
    ImplicitHiddenModels.getCached({ userId, refreshCache }),
  ]);

  const explicit = removeEmpty({
    users,
    images,
    models,
  });

  const hidden = removeEmpty({
    tags: hiddenTags,
    images: implicitImages.hidden,
    model: implicitModels.hidden,
  });

  const moderated = removeEmpty({
    tags: moderatedTags,
    images: implicitImages.moderated,
    model: implicitModels.moderated,
  });

  return removeEmpty({ explicit, hidden, moderated });
}

export async function toggleHiddenTags({
  tagIds,
  userId,
  hidden,
}: {
  tagIds: number[];
  userId: number;
  hidden?: boolean;
}) {
  if (hidden === false) {
    await dbWrite.tagEngagement.deleteMany({
      where: { userId, tagId: { in: tagIds }, type: 'Hide' },
    });
  } else {
    const matchedTags = await dbWrite.tagEngagement.findMany({
      where: { userId, tagId: { in: tagIds } },
      select: { tagId: true, type: true },
    });

    const existingHidden = matchedTags.filter((x) => x.type !== 'Hide').map((x) => x.tagId);
    const toCreate = tagIds.filter((id) => !existingHidden.includes(id));
    // if hidden === true, then I only need to create non-existing tagEngagements, no need to remove an engagements
    const toDelete = hidden ? [] : tagIds.filter((id) => existingHidden.includes(id));

    if (toCreate.length) {
      await dbWrite.tagEngagement.createMany({
        data: toCreate.map((tagId) => ({ userId, tagId, type: 'Hide' })),
      });
    }
    if (toDelete.length) {
      await dbWrite.tagEngagement.deleteMany({
        where: { userId, tagId: { in: toDelete } },
      });
    }
  }

  const tags = HiddenTags.getCached({ userId, refreshCache: true });
  // these functions depend on having fresh data from tags
  const [images, models] = await Promise.all([
    ImplicitHiddenImages.getCached({ userId, refreshCache: true }),
    ImplicitHiddenModels.getCached({ userId, refreshCache: true }),
  ]);

  return { tags, images, models };
}

export async function toggleHideModel({ userId, modelId }: { userId: number; modelId: number }) {
  const engagement = await dbWrite.modelEngagement.findUnique({
    where: { userId_modelId: { userId, modelId } },
    select: { type: true },
  });
  if (!engagement)
    await dbWrite.modelEngagement.create({ data: { userId, modelId, type: 'Hide' } });
  else if (engagement.type === 'Hide')
    await dbWrite.modelEngagement.delete({ where: { userId_modelId: { userId, modelId } } });
  else
    await dbWrite.modelEngagement.update({
      where: { userId_modelId: { userId, modelId } },
      data: { type: 'Hide' },
    });

  await HiddenModels.refreshCache({ userId });
}

export async function toggleHideUser({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}) {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { userId, targetUserId } },
    select: { type: true },
  });
  if (!engagement)
    await dbWrite.userEngagement.create({ data: { userId, targetUserId, type: 'Hide' } });
  else if (engagement.type === 'Hide')
    await dbWrite.userEngagement.delete({
      where: { userId_targetUserId: { userId, targetUserId } },
    });
  else
    await dbWrite.userEngagement.update({
      where: { userId_targetUserId: { userId, targetUserId } },
      data: { type: 'Hide' },
    });

  await HiddenUsers.refreshCache({ userId });
}

export async function toggleHideImage({ userId, imageId }: { userId: number; imageId: number }) {
  const engagement = await dbWrite.imageEngagement.findUnique({
    where: { userId_imageId: { userId, imageId } },
    select: { type: true },
  });
  if (!engagement)
    await dbWrite.imageEngagement.create({ data: { userId, imageId, type: 'Hide' } });
  else if (engagement.type === 'Hide')
    await dbWrite.imageEngagement.delete({
      where: { userId_imageId: { userId, imageId } },
    });
  else
    await dbWrite.imageEngagement.update({
      where: { userId_imageId: { userId, imageId } },
      data: { type: 'Hide' },
    });

  await HiddenImages.refreshCache({ userId });
}
