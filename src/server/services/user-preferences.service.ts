import { TagEngagementType, UserEngagementType } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';

import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import { getModeratedTags } from '~/server/services/system-cache';
import { isDefined } from '~/utils/type-guards';

const HIDDEN_CACHE_EXPIRY = 60 * 60 * 4;
// const log = createLogger('user-preferences', 'green');

function createUserCache<T, TArgs extends { userId?: number }>({
  key,
  callback,
}: {
  key: string;
  callback: (args: TArgs) => Promise<T>;
}) {
  const getCached = async ({
    userId = -1, // Default to civitai account
    refreshCache,
    ...rest
  }: TArgs & { refreshCache?: boolean }) => {
    const cachedTags = await redis.get(`user:${userId}:${key}`);
    if (cachedTags && !refreshCache) return JSON.parse(cachedTags) as T;
    if (refreshCache) await redis.del(`user:${userId}:${key}`);

    return await get({ userId, ...rest } as TArgs);
  };

  const get = async ({ userId = -1, ...rest }: TArgs) => {
    // console.time(key);
    const data = await callback({ userId, ...rest } as TArgs);
    // console.timeEnd(key);

    await redis.set(`user:${userId}:${key}`, JSON.stringify(data), {
      EX: HIDDEN_CACHE_EXPIRY,
    });

    return data;
  };

  const refreshCache = async ({ userId }: { userId: number }) => {
    // log(`refreshing ${logLabel} for user`, userId);
    await redis.del(`user:${userId}:${key}`);
  };

  const getKey = ({ userId = -1 }: { userId?: number }) => `user:${userId}:${key}`;

  const parseJson = (value: string) => JSON.parse(value) as T;

  return {
    get,
    getCached,
    getKey,
    refreshCache,
    parseJson,
  };
}

// const getHiddenTagsOfHiddenTags = async (tagIds: number[]) => {
//   const tagsOnTags = await dbWrite.tagsOnTags.findMany({
//     where: { fromTagId: { in: [...tagIds] }, type: 'Parent' },
//     select: { fromTagId: true, toTag: { select: { id: true, name: true } } },
//   });

//   return tagsOnTags
//     .map(({ fromTagId, toTag }) => {
//       const parentTag = tagIds.find((id) => id === fromTagId);
//       if (!parentTag) return null;
//       return { ...toTag, parentId: fromTagId };
//     })
//     .filter(isDefined);
// };

const HiddenTags = createUserCache({
  key: 'hidden-tags-4',
  callback: async ({ userId }) => {
    const tagEngagment = (
      await dbWrite.tagEngagement.findMany({
        where: { userId, type: TagEngagementType.Hide },
        select: { tag: { select: { id: true, name: true } } },
      })
    ).map((x) => x.tag);
    // const hiddenTags = tagEngagment.map((x) => x.id);

    // const hiddenTagsOfHiddenTags = await getHiddenTagsOfHiddenTags(hiddenTags);

    return [...tagEngagment];
  },
});

// images hidden by toggling 'hide image'
export const HiddenImages = createUserCache({
  key: 'hidden-images-3',
  callback: async ({ userId }) =>
    (
      await dbWrite.imageEngagement.findMany({
        where: { userId, type: UserEngagementType.Hide },
        select: { imageId: true },
      })
    ).map((x) => x.imageId),
});

// images hidden by voting for tags in user's hidden/moderated tags
const getVotedHideImages = async ({
  hiddenTagIds = [],
  moderatedTagIds = [],
  userId,
}: {
  hiddenTagIds?: number[];
  moderatedTagIds?: number[];
  userId: number;
}) => {
  const allHidden = [...new Set([...hiddenTagIds, ...moderatedTagIds])];
  if (!allHidden.length) return [];
  const votedHideImages = await dbWrite.tagsOnImageVote.findMany({
    where: { userId, tagId: { in: allHidden }, vote: { gt: 0 }, applied: false },
    select: { imageId: true, tagId: true },
  });

  // TODO.Briant
  /*
    Instead of returning every image the user has voted on that matches their hidden preferences, only return the images the user has voted on where the tag hasn't been applied to the image yet (due to scoring, moderator controls)
    tagsOnImage.disabled indicates that the tag isn't applied
  */
  const hidden = votedHideImages.filter((x) => hiddenTagIds.includes(x.tagId));
  const moderated = votedHideImages.filter((x) => moderatedTagIds.includes(x.tagId));
  const combined = [...hidden, ...moderated].map((x) => ({ id: x.imageId, tagId: x.tagId }));
  return combined as HiddenImage[];
};

export const ImplicitHiddenImages = createUserCache({
  key: 'hidden-images-implicit',
  callback: async ({
    userId,
    hiddenTagIds,
    moderatedTagIds,
  }: {
    userId: number;
    hiddenTagIds: number[];
    moderatedTagIds: number[];
  }) => {
    return await getVotedHideImages({
      hiddenTagIds,
      moderatedTagIds,
      userId,
    });
  },
});

export const HiddenModels = createUserCache({
  key: 'hidden-models-3',
  callback: async ({ userId }) =>
    (
      await dbWrite.modelEngagement.findMany({
        where: { userId, type: UserEngagementType.Hide },
        select: { modelId: true },
      })
    ).map((x) => x.modelId),
});

export const HiddenUsers = createUserCache({
  key: 'hidden-users-3',
  callback: async ({ userId }) =>
    await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
        SELECT
          ue."targetUserId" "id",
          (SELECT u.username FROM "User" u WHERE u.id = ue."targetUserId") "username"
        FROM "UserEngagement" ue
        WHERE "userId" = ${userId} AND type = ${UserEngagementType.Hide}::"UserEngagementType"
      `,
});

export interface HiddenPreferenceBase {
  id: number;
  /** the presence of hidden: true indicates that this is a user setting*/
  hidden?: boolean;
}

export interface HiddenTag extends HiddenPreferenceBase {
  id: number;
  name: string;
  /** the presence of nsfwLevel indicates that this is a moderated tag*/
  nsfwLevel?: NsfwLevel;
  parentId?: number;
  hidden?: boolean;
}

interface HiddenUser extends HiddenPreferenceBase {
  id: number;
  username?: string | null;
  hidden: boolean;
}

interface HiddenModel extends HiddenPreferenceBase {
  id: number;
  hidden: boolean;
}

interface HiddenImage extends HiddenPreferenceBase {
  id: number;
  /** the presence of a tagId indicates that this image is hidden due to a user's tag vote */
  tagId?: number;
  hidden?: boolean;
}

type HiddenPreferencesKind =
  | ({ kind: 'tag' } & HiddenTag)
  | ({ kind: 'model' } & HiddenModel)
  | ({ kind: 'image' } & HiddenImage)
  | ({ kind: 'user' } & HiddenUser);

interface HiddenPreferencesDiff {
  added: Array<HiddenPreferencesKind>;
  removed: Array<HiddenPreferencesKind>;
}

export type HiddenPreferenceTypes = {
  hiddenTags: HiddenTag[];
  hiddenUsers: HiddenUser[];
  hiddenModels: HiddenModel[];
  hiddenImages: HiddenImage[];
};

const getAllHiddenForUsersCached = async ({
  userId = -1, // Default to civitai account
}: {
  userId?: number;
}) => {
  const [
    cachedSystemHiddenTags,
    cachedHiddenTags,
    cachedHiddenImages,
    cachedHiddenModels,
    cachedHiddenUsers,
    cachedImplicitHiddenImages,
  ] = await redis.mGet([
    REDIS_KEYS.SYSTEM.MODERATED_TAGS,
    HiddenTags.getKey({ userId }),
    HiddenImages.getKey({ userId }),
    HiddenModels.getKey({ userId }),
    HiddenUsers.getKey({ userId }),
    ImplicitHiddenImages.getKey({ userId }),
  ]);

  const getModerationTags = async () =>
    cachedSystemHiddenTags
      ? (JSON.parse(cachedSystemHiddenTags) as AsyncReturnType<typeof getModeratedTags>)
      : await getModeratedTags();

  const getHiddenTags = async ({ userId }: { userId: number }) =>
    cachedHiddenTags ? HiddenTags.parseJson(cachedHiddenTags) : await HiddenTags.get({ userId });

  const getHiddenImages = async ({ userId }: { userId: number }) =>
    cachedHiddenImages
      ? HiddenImages.parseJson(cachedHiddenImages)
      : await HiddenImages.get({ userId });

  const getHiddenModels = async ({ userId }: { userId: number }) =>
    cachedHiddenModels
      ? HiddenModels.parseJson(cachedHiddenModels)
      : await HiddenModels.get({ userId });

  const getHiddenUsers = async ({ userId }: { userId: number }) =>
    cachedHiddenUsers
      ? HiddenUsers.parseJson(cachedHiddenUsers)
      : await HiddenUsers.get({ userId });

  const getHiddenImplicitImages = async ({
    userId,
    hiddenTagIds,
    moderatedTagIds,
  }: {
    userId: number;
    hiddenTagIds: number[];
    moderatedTagIds: number[];
  }) =>
    cachedImplicitHiddenImages
      ? ImplicitHiddenImages.parseJson(cachedImplicitHiddenImages)
      : await ImplicitHiddenImages.get({ userId, hiddenTagIds, moderatedTagIds });

  const [moderatedTags, hiddenTags, images, models, users] = await Promise.all([
    getModerationTags(),
    getHiddenTags({ userId }),
    getHiddenImages({ userId }),
    getHiddenModels({ userId }),
    getHiddenUsers({ userId }),
  ]);

  const [implicitImages] = await Promise.all([
    getHiddenImplicitImages({
      userId,
      hiddenTagIds: hiddenTags.map((x) => x.id),
      moderatedTagIds: moderatedTags.map((x) => x.id),
    }),
  ]);

  return { moderatedTags, hiddenTags, images, models, users, implicitImages };
};

const getAllHiddenForUserFresh = async ({ userId }: { userId: number }) => {
  const [moderatedTags, hiddenTags, images, models, users] = await Promise.all([
    getModeratedTags(),
    HiddenTags.get({ userId }),
    HiddenImages.get({ userId }),
    HiddenModels.get({ userId }),
    HiddenUsers.get({ userId }),
  ]);

  const [implicitImages] = await Promise.all([
    ImplicitHiddenImages.get({
      userId,
      hiddenTagIds: hiddenTags.map((x) => x.id),
      moderatedTagIds: moderatedTags.map((x) => x.id),
    }),
  ]);

  return { moderatedTags, hiddenTags, images, models, users, implicitImages };
};

export async function getAllHiddenForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}): Promise<HiddenPreferenceTypes> {
  const { moderatedTags, hiddenTags, images, models, users, implicitImages } = refreshCache
    ? await getAllHiddenForUserFresh({ userId })
    : await getAllHiddenForUsersCached({ userId });

  const result = {
    hiddenImages: [...images.map((id) => ({ id, hidden: true })), ...implicitImages],
    hiddenModels: [...models.map((id) => ({ id, hidden: true }))],
    hiddenUsers: users.map((user) => ({ ...user, hidden: true })),
    hiddenTags: [...hiddenTags.map((tag) => ({ ...tag, hidden: true })), ...moderatedTags],
  } as HiddenPreferenceTypes;
  return result;
}

export async function toggleHidden({
  kind,
  data,
  hidden,
  userId,
}: ToggleHiddenSchemaOutput & { userId: number }): Promise<HiddenPreferencesDiff> {
  switch (kind) {
    case 'image':
      return await toggleHideImage({ userId, imageId: data[0].id });
    case 'model':
      return await toggleHideModel({ userId, modelId: data[0].id });
    case 'user':
      return await toggleHideUser({ userId, targetUserId: data[0].id, setTo: hidden });
    case 'tag':
      return await toggleHiddenTags({ tagIds: data.map((x) => x.id), hidden, userId });
    default:
      throw new Error('unsupported hidden toggle kind');
  }
}

async function toggleHiddenTags({
  tagIds,
  userId,
  hidden,
}: {
  tagIds: number[];
  userId: number;
  hidden?: boolean;
}): Promise<HiddenPreferencesDiff> {
  let addedTags: number[] = [];
  let deletedTags: number[] = [];

  if (hidden === false) {
    deletedTags = tagIds;
    await dbWrite.tagEngagement.deleteMany({
      where: { userId, tagId: { in: tagIds }, type: 'Hide' },
    });
  } else {
    const matchedTags = await dbWrite.tagEngagement.findMany({
      where: { userId, tagId: { in: tagIds } },
      select: { tagId: true, type: true },
    });

    const existing = matchedTags.map((x) => x.tagId);
    const existingHidden = matchedTags.filter((x) => x.type === 'Hide').map((x) => x.tagId);
    const toUpdate = tagIds.filter((id) => !existingHidden.includes(id) && existing.includes(id));
    const toCreate = tagIds.filter((id) => !existing.includes(id));
    // if hidden === true, then I only need to create non-existing tagEngagements, no need to remove an engagements
    const toDelete = hidden ? [] : tagIds.filter((id) => existingHidden.includes(id));

    if (toDelete.length) {
      await dbWrite.tagEngagement.deleteMany({
        where: { userId, tagId: { in: toDelete } },
      });
    }
    if (toUpdate.length) {
      await dbWrite.tagEngagement.updateMany({
        where: { userId, tagId: { in: toUpdate } },
        data: { type: 'Hide' },
      });
    }
    if (toCreate.length) {
      await dbWrite.tagEngagement.createMany({
        data: toCreate.map((tagId) => ({ userId, tagId, type: 'Hide' })),
      });
    }

    addedTags = [...new Set([...toUpdate, ...toCreate])];
    deletedTags = [...toDelete];
  }

  const hiddenChangedIds = [...addedTags, ...deletedTags];

  const [
    votedHideImages,
    // changedHiddenTagsOfHiddenTags
  ] = await Promise.all([
    getVotedHideImages({ hiddenTagIds: hiddenChangedIds, userId }),
    // getHiddenTagsOfHiddenTags(hiddenChangedIds),
  ]);

  await Promise.all([
    HiddenTags.refreshCache({ userId }),
    ImplicitHiddenImages.refreshCache({ userId }),
  ]);

  const addedFn = <T extends { tagId?: number }>({ tagId }: T) =>
    tagId && addedTags.includes(tagId);
  const removeFn = <T extends { tagId?: number }>({ tagId }: T) =>
    tagId && deletedTags.includes(tagId);

  const imageMap = (image: HiddenImage): HiddenPreferencesKind => ({ ...image, kind: 'image' });
  // const tagMap = (tag: HiddenTag): HiddenPreferencesKind => ({ ...tag, kind: 'tag' });

  return {
    added: [
      ...votedHideImages.filter(addedFn).map(imageMap),
      // ...changedHiddenTagsOfHiddenTags.filter((x) => addedTags.includes(x.parentId)).map(tagMap),
    ],
    removed: [
      ...votedHideImages.filter(removeFn).map(imageMap),
      // ...changedHiddenTagsOfHiddenTags.filter((x) => deletedTags.includes(x.parentId)).map(tagMap),
    ],
  };
}

async function toggleHideModel({
  userId,
  modelId,
}: {
  userId: number;
  modelId: number;
}): Promise<HiddenPreferencesDiff> {
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

  // const addedOrUpdated = !engagement || engagement.type !== 'Hide';
  // const toReturn = { id: modelId, kind: 'model' } as HiddenPreferencesKind;

  return {
    added: [],
    removed: [],
  };
}

async function toggleHideUser({
  userId,
  targetUserId,
  setTo,
}: {
  userId: number;
  targetUserId: number;
  setTo?: boolean;
}): Promise<HiddenPreferencesDiff> {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { userId, targetUserId } },
    select: { type: true },
  });
  if (!engagement)
    await dbWrite.userEngagement.create({
      data: { userId, targetUserId, type: 'Hide' },
    });
  else if (engagement.type === 'Hide' && setTo !== true)
    await dbWrite.userEngagement.delete({
      where: { userId_targetUserId: { userId, targetUserId } },
    });
  else
    await dbWrite.userEngagement.update({
      where: { userId_targetUserId: { userId, targetUserId } },
      data: { type: 'Hide' },
    });

  // const addedOrUpdated = !engagement || engagement.type !== 'Hide';
  // const user = await dbRead.user.findUnique({
  //   where: { id: targetUserId },
  //   select: { id: true, username: true },
  // });

  // const toReturn = user ? ({ ...user, kind: 'user' } as HiddenPreferencesKind) : undefined;

  await HiddenUsers.refreshCache({ userId });

  return {
    added: [],
    removed: [],
  };
}

async function toggleHideImage({
  userId,
  imageId,
}: {
  userId: number;
  imageId: number;
}): Promise<HiddenPreferencesDiff> {
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

  // const addedOrUpdated = !engagement || engagement.type !== 'Hide';
  // const toReturn = { id: imageId, kind: 'image' } as HiddenPreferencesKind;

  return {
    added: [],
    removed: [],
  };
}
