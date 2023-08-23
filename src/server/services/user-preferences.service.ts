import { NsfwLevel, TagEngagementType, UserEngagementType } from '@prisma/client';
import { uniqBy } from 'lodash-es';

import { dbRead, dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import { getModerationTags, getSystemHiddenTags } from '~/server/services/system-cache';
import {
  refreshHiddenImagesForUser,
  refreshHiddenModelsForUser,
  refreshHiddenTagsForUser,
  refreshHiddenUsersForUser,
} from '~/server/services/user-cache.service';
import { createLogger } from '~/utils/logging';
import { isDefined } from '~/utils/type-guards';

const HIDDEN_CACHE_EXPIRY = 60 * 60 * 4;
const log = createLogger('user-preferences', 'green');

const getModerated = async () => {
  const moderated = await getModerationTags();
  return moderated.map((x) => x.id);
};

function createUserCache<T, TArgs extends { userId: number }>({
  // logLabel,
  key,
  callback,
}: {
  // logLabel: string;
  key: string;
  callback: (args: TArgs) => Promise<T>;
}) {
  const getCached = async ({
    userId = -1, // Default to civitai account
    refreshCache,
    ...rest
  }: TArgs & {
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

  return {
    get,
    getCached,
    getKey,
    refreshCache,
  };
}

const getHiddenTagsOfHiddenTags = async (tagIds: number[]) => {
  return await dbWrite.tagsOnTags.findMany({
    where: { fromTagId: { in: [...tagIds] } },
    select: { fromTagId: true, toTag: { select: { id: true, name: true } } },
  });
};

const HiddenTags = createUserCache({
  // logLabel: 'hidden tags',
  key: 'hidden-tags-2',
  callback: async ({ userId }) => {
    const tagEngagment = (
      await dbWrite.tagEngagement.findMany({
        where: { userId, type: TagEngagementType.Hide },
        select: { tag: { select: { id: true, name: true } } },
      })
    ).map((x) => x.tag);
    const hiddenTags = tagEngagment.map((x) => x.id);

    const hiddenTagsOfHiddenTags = await getHiddenTagsOfHiddenTags(hiddenTags);

    const tags = uniqBy([...tagEngagment, ...hiddenTagsOfHiddenTags.map((x) => x.toTag)], 'id');
    return tags;
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

const getVotedHideImages = async ({
  hiddenIds = [],
  moderatedIds = [],
  userId,
}: {
  hiddenIds?: number[];
  moderatedIds?: number[];
  userId: number;
}) => {
  const allHidden = [...new Set([...hiddenIds, ...moderatedIds])];
  if (!allHidden.length) return [];
  const votedHideImages = await dbWrite.tagsOnImageVote.findMany({
    where: { userId, tagId: { in: allHidden }, vote: { gt: 0 } },
    select: { imageId: true, tagId: true },
  });

  const hidden = votedHideImages.filter((x) => hiddenIds.includes(x.tagId));
  const moderated = votedHideImages.filter((x) => moderatedIds.includes(x.tagId));

  return [
    ...hidden.map((x) => ({ id: x.imageId, type: 'hidden', tagId: x.tagId })),
    ...moderated.map((x) => ({ id: x.imageId, type: 'moderated', tagId: x.tagId })),
  ] as HiddenImage[];
};

const ImplicitHiddenImages = createUserCache({
  key: 'hidden-images-implicit',
  callback: async ({ userId, hiddenTagIds }: { userId: number; hiddenTagIds: number[] }) => {
    const hiddenIds = hiddenTagIds;
    const moderatedIds = await getModerated();

    return await getVotedHideImages({ hiddenIds, moderatedIds, userId });
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

const getVotedHideModels = async ({
  hiddenIds = [],
  moderatedIds = [],
  userId,
}: {
  hiddenIds?: number[];
  moderatedIds?: number[];
  userId: number;
}) => {
  const allHidden = [...new Set([...hiddenIds, ...moderatedIds])];
  if (!allHidden.length) return [];
  const votedHideModels = await dbWrite.tagsOnModelsVote.findMany({
    where: { userId, tagId: { in: allHidden }, vote: { gt: 0 } },
    select: { modelId: true, tagId: true },
  });

  const hidden = votedHideModels.filter((x) => hiddenIds.includes(x.tagId));
  const moderated = votedHideModels.filter((x) => moderatedIds.includes(x.tagId));

  return [
    ...hidden.map((x) => ({ id: x.modelId, type: 'hidden', tagId: x.tagId })),
    ...moderated.map((x) => ({ id: x.modelId, type: 'moderated', tagId: x.tagId })),
  ] as HiddenModel[];
};

const ImplicitHiddenModels = createUserCache({
  key: 'hidden-models-implicit',
  callback: async ({ userId, hiddenTagIds }: { userId: number; hiddenTagIds: number[] }) => {
    const hiddenIds = hiddenTagIds;
    const moderatedIds = await getModerated();

    return await getVotedHideModels({ hiddenIds, moderatedIds, userId });
  },
});

const HiddenUsers = createUserCache({
  key: 'hidden-users-2',
  callback: async ({ userId }) =>
    await dbWrite.$queryRaw<{ id: number; username: string | null }[]>`
        SELECT
          ue."targetUserId" "id",
          (SELECT u.username FROM "User" u WHERE u.id = ue."targetUserId") "username"
        FROM "UserEngagement" ue
        WHERE "userId" = ${userId} AND type = ${UserEngagementType.Hide}::"UserEngagementType"
      `,
});

type HiddenPreferenceType = 'hidden' | 'moderated' | 'always';
export interface HiddenPreferenceBase {
  id: number;
  type: HiddenPreferenceType;
}

interface HiddenTag extends HiddenPreferenceBase {
  id: number;
  name: string;
  nsfw?: NsfwLevel;
  type: HiddenPreferenceType;
}

interface HiddenUser extends HiddenPreferenceBase {
  id: number;
  username?: string | null;
  type: HiddenPreferenceType;
}

interface HiddenModel extends HiddenPreferenceBase {
  id: number;
  type: HiddenPreferenceType;
  tagId?: number;
}

interface HiddenImage extends HiddenPreferenceBase {
  id: number;
  type: HiddenPreferenceType;
  tagId?: number;
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
  tag: HiddenTag[];
  user: HiddenUser[];
  model: HiddenModel[];
  image: HiddenImage[];
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
    cachedImplicitHiddenModels,
  ] = await redis.mGet([
    'system:hidden-tags-2',
    HiddenTags.getKey({ userId }),
    HiddenImages.getKey({ userId }),
    HiddenModels.getKey({ userId }),
    HiddenUsers.getKey({ userId }),
    ImplicitHiddenImages.getKey({ userId }),
    ImplicitHiddenModels.getKey({ userId }),
  ]);
  // console.log({
  //   cachedSystemHiddenTags,
  //   cachedHiddenTags,
  //   cachedHiddenImages,
  //   cachedHiddenModels,
  //   cachedHiddenUsers,
  //   cachedImplicitHiddenImages,
  //   cachedImplicitHiddenModels,
  // });

  const getModeratedTags = async () =>
    cachedSystemHiddenTags
      ? (JSON.parse(cachedSystemHiddenTags) as AsyncReturnType<typeof getSystemHiddenTags>)
      : await getSystemHiddenTags();

  const getHiddenTags = async ({ userId }: { userId: number }) =>
    cachedHiddenTags
      ? (JSON.parse(cachedHiddenTags) as AsyncReturnType<typeof HiddenTags.get>)
      : await HiddenTags.get({ userId });

  const getHiddenImages = async ({ userId }: { userId: number }) =>
    cachedHiddenImages
      ? (JSON.parse(cachedHiddenImages) as AsyncReturnType<typeof HiddenImages.get>)
      : await HiddenImages.get({ userId });

  const getHiddenModels = async ({ userId }: { userId: number }) =>
    cachedHiddenModels
      ? (JSON.parse(cachedHiddenModels) as AsyncReturnType<typeof HiddenModels.get>)
      : await HiddenModels.get({ userId });

  const getHiddenUsers = async ({ userId }: { userId: number }) =>
    cachedHiddenUsers
      ? (JSON.parse(cachedHiddenUsers) as AsyncReturnType<typeof HiddenUsers.get>)
      : await HiddenUsers.get({ userId });

  const getHiddenImplicitImages = async ({
    userId,
    hiddenTagIds,
  }: {
    userId: number;
    hiddenTagIds: number[];
  }) =>
    cachedImplicitHiddenImages
      ? (JSON.parse(cachedImplicitHiddenImages) as AsyncReturnType<typeof ImplicitHiddenImages.get>)
      : await ImplicitHiddenImages.get({ userId, hiddenTagIds });

  const getHiddenImplicitModels = async ({
    userId,
    hiddenTagIds,
  }: {
    userId: number;
    hiddenTagIds: number[];
  }) =>
    cachedImplicitHiddenModels
      ? (JSON.parse(cachedImplicitHiddenModels) as AsyncReturnType<typeof ImplicitHiddenModels.get>)
      : await ImplicitHiddenModels.get({ userId, hiddenTagIds });

  const [moderatedTags, hiddenTags, images, models, users] = await Promise.all([
    getModeratedTags(),
    getHiddenTags({ userId }),
    getHiddenImages({ userId }),
    getHiddenModels({ userId }),
    getHiddenUsers({ userId }),
  ]);

  const [implicitImages, implicitModels] = await Promise.all([
    getHiddenImplicitImages({ userId, hiddenTagIds: hiddenTags.map((x) => x.id) }),
    getHiddenImplicitModels({ userId, hiddenTagIds: hiddenTags.map((x) => x.id) }),
  ]);

  return { moderatedTags, hiddenTags, images, models, users, implicitImages, implicitModels };
};

const getAllHiddenForUserFresh = async ({ userId }: { userId: number }) => {
  const [moderatedTags, hiddenTags, images, models, users] = await Promise.all([
    getSystemHiddenTags(),
    HiddenTags.get({ userId }),
    HiddenImages.get({ userId }),
    HiddenModels.get({ userId }),
    HiddenUsers.get({ userId }),
  ]);

  // these two are dependent on the values from HiddenTags
  const [implicitImages, implicitModels] = await Promise.all([
    ImplicitHiddenImages.get({
      userId,
      hiddenTagIds: hiddenTags.map((x) => x.id),
    }),
    ImplicitHiddenModels.get({
      userId,
      hiddenTagIds: hiddenTags.map((x) => x.id),
    }),
  ]);

  return { moderatedTags, hiddenTags, images, models, users, implicitImages, implicitModels };
};

export async function getAllHiddenForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}): Promise<HiddenPreferenceTypes> {
  // console.time(!refreshCache ? 'get cached' : 'get fresh');
  const { moderatedTags, hiddenTags, images, models, users, implicitImages, implicitModels } =
    refreshCache
      ? await getAllHiddenForUserFresh({ userId })
      : await getAllHiddenForUsersCached({ userId });
  // console.timeEnd(!refreshCache ? 'get cached' : 'get fresh');

  const moderated = moderatedTags
    .filter((x) => x.nsfw !== NsfwLevel.Blocked)
    .map((tag) => ({ ...tag, type: 'moderated' }));
  const blocked = moderatedTags
    .filter((x) => x.nsfw === NsfwLevel.Blocked)
    .map((tag) => ({ ...tag, type: 'always' }));

  return {
    image: [...images.map((id) => ({ id, type: 'always' })), ...implicitImages],
    model: [...models.map((id) => ({ id, type: 'always' })), ...implicitModels],
    user: [...users.map((user) => ({ ...user, type: 'always' }))],
    tag: [...hiddenTags.map((tag) => ({ ...tag, type: 'hidden' })), ...moderated, ...blocked],
  } as HiddenPreferenceTypes;
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
      return await toggleHideUser({ userId, targetUserId: data[0].id });
    case 'tag':
      return await toggleHiddenTags({ tagIds: data.map((x) => x.id), hidden, userId });
    default:
      throw new Error('unsupported hidden toggle kind');
  }
}

export type ToggleHiddenTagsReturn = AsyncReturnType<typeof toggleHiddenTags>;
export async function toggleHiddenTags({
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

  const [votedHideModels, votedHideImages, changedHiddenTagsOfHiddenTags] = await Promise.all([
    getVotedHideModels({ hiddenIds: hiddenChangedIds, userId }),
    getVotedHideImages({ hiddenIds: hiddenChangedIds, userId }),
    getHiddenTagsOfHiddenTags(hiddenChangedIds),
  ]);

  await Promise.all([
    HiddenTags.refreshCache({ userId }),
    ImplicitHiddenImages.refreshCache({ userId }),
    ImplicitHiddenModels.refreshCache({ userId }),
    refreshHiddenTagsForUser({ userId }), // TODO - remove this once front end filtering is finished
    refreshHiddenImagesForUser({ userId }), // TODO - remove this once front end filtering is finished
    refreshHiddenModelsForUser({ userId }), // TODO - remove this once front end filtering is finished
  ]);

  const addedFn = <T extends { tagId?: number }>({ tagId }: T) =>
    tagId && addedTags.includes(tagId);
  const removeFn = <T extends { tagId?: number }>({ tagId }: T) =>
    tagId && deletedTags.includes(tagId);

  const imageMap = (image: HiddenImage): HiddenPreferencesKind => ({ ...image, kind: 'image' });
  const modelMap = (model: HiddenModel): HiddenPreferencesKind => ({ ...model, kind: 'model' });

  return {
    added: [
      ...votedHideImages.filter(addedFn).map(imageMap),
      ...votedHideModels.filter(addedFn).map(modelMap),
      ...changedHiddenTagsOfHiddenTags
        .filter((x) => addedTags.includes(x.fromTagId))
        .map(({ toTag }): HiddenPreferencesKind => ({ ...toTag, kind: 'tag', type: 'hidden' })),
    ],
    removed: [
      ...votedHideImages.filter(removeFn).map(imageMap),
      ...votedHideModels.filter(removeFn).map(modelMap),
      ...changedHiddenTagsOfHiddenTags
        .filter((x) => deletedTags.includes(x.fromTagId))
        .map(({ toTag }): HiddenPreferencesKind => ({ ...toTag, kind: 'tag', type: 'hidden' })),
    ],
  };
}

export async function toggleHideModel({
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
  await refreshHiddenModelsForUser({ userId }); // TODO - remove this once front end filtering is finished

  return {
    added: [],
    removed: [],
  };
}

export async function toggleHideUser({
  userId,
  targetUserId,
}: {
  userId: number;
  targetUserId: number;
}): Promise<HiddenPreferencesDiff> {
  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { userId, targetUserId } },
    select: { type: true },
  });
  if (!engagement)
    await dbWrite.userEngagement.create({
      data: { userId, targetUserId, type: 'Hide' },
    });
  else if (engagement.type === 'Hide')
    await dbWrite.userEngagement.delete({
      where: { userId_targetUserId: { userId, targetUserId } },
    });
  else
    await dbWrite.userEngagement.update({
      where: { userId_targetUserId: { userId, targetUserId } },
      data: { type: 'Hide' },
    });

  const addedOrUpdated = !engagement || engagement.type !== 'Hide';
  const user = await dbRead.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true },
  });

  const toReturn = user
    ? ({ ...user, kind: 'user', type: 'always' } as HiddenPreferencesKind)
    : undefined;

  await HiddenUsers.refreshCache({ userId });
  await refreshHiddenUsersForUser({ userId }); // TODO - remove this once front end filtering is finished

  return {
    added: addedOrUpdated ? [toReturn].filter(isDefined) : [],
    removed: !addedOrUpdated ? [toReturn].filter(isDefined) : [],
  };
}

export async function toggleHideImage({
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
  await refreshHiddenImagesForUser({ userId }); // TODO - remove this once front end filtering is finished

  return {
    added: [],
    removed: [],
  };
}
