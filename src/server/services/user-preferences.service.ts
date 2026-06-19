import type { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { userFollowsCache } from '~/server/redis/caches';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import { getModeratedTags } from '~/server/services/system-cache';
import { withSpan } from '~/server/utils/otel-helpers';
import { TagEngagementType, UserEngagementType } from '~/shared/utils/prisma/enums';

const HIDDEN_CACHE_EXPIRY_BASE = 60 * 60 * 4; // 4 hours
const HIDDEN_CACHE_JITTER_MAX = 60 * 30; // up to 30 minutes of jitter
// Jitter prevents thundering herd: without it, all users' caches expire at the
// same 4-hour boundary, causing a simultaneous DB query storm at ~300 req/s.
function getHiddenCacheExpiry() {
  return HIDDEN_CACHE_EXPIRY_BASE + Math.floor(Math.random() * HIDDEN_CACHE_JITTER_MAX);
}
// const log = createLogger('user-preferences', 'green');

// All of a user's hidden-preference caches are stored as FIELDS of ONE per-user
// hash (`packed:user:<id>:hidden-prefs`), so getAllHiddenForUsersCached can read
// them in a single HGETALL instead of N individual GETs — the largest Redis
// contributor on the feed path. The hash field name is the per-pref `key`, so
// the individual consumers (getCached/refreshCache, used across ~10 services)
// keep working — they just operate on their field via HGET/HDEL.
const HIDDEN_PREFS_HASH = 'hidden-prefs';
const getUserPrefsHashKey = (userId = -1) =>
  `${REDIS_KEYS.USER.CACHE}:${userId}:${HIDDEN_PREFS_HASH}` as RedisKeyTemplateCache;

function createUserCache<T, TArgs extends { userId?: number }>({
  key,
  callback,
}: {
  key: string;
  callback: (args: TArgs) => Promise<T>;
}) {
  const field = key;
  // Fetch from source (DB) and write the field into the per-user hash. The TTL
  // is set with `NX` (only when the hash has none), so the whole hash ages out
  // ~maxExpiry after its FIRST population rather than having its expiry bumped
  // on every field write. This preserves the self-healing backstop the old
  // per-key TTLs gave: if an invalidation is ever missed, the field can't go
  // stale indefinitely — the hash expires and is rebuilt. (Jitter on first
  // population still staggers expiry across users to avoid a herd.)
  const get = async ({ userId = -1, ...rest }: TArgs) => {
    const data = await callback({ userId, ...rest } as TArgs);
    const hashKey = getUserPrefsHashKey(userId);
    await redis.packed.hSet(hashKey, field, data);
    await redis.expire(hashKey, getHiddenCacheExpiry(), 'NX');
    return data;
  };

  const getCached = async ({
    userId = -1, // Default to civitai account
    refreshCache,
    ...rest
  }: TArgs & { refreshCache?: boolean }) => {
    if (refreshCache) {
      await refresh({ userId });
      return await get({ userId, ...rest } as TArgs);
    }
    const cached = await redis.packed.hGet<T>(getUserPrefsHashKey(userId), field);
    if (cached != null) return cached;
    return await get({ userId, ...rest } as TArgs);
  };

  // Invalidate: drop the hash field so the next read repopulates from source.
  const refresh = async ({ userId = -1 }: { userId?: number }) => {
    await redis.hDel(getUserPrefsHashKey(userId), field);
  };

  return {
    get,
    getCached,
    field,
    refreshCache: refresh,
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
  // Inner join filters orphan TagEngagement rows (tagId → deleted Tag) that
  // would otherwise make Prisma throw "Inconsistent query result: Field tag
  // is required to return data, got `null` instead" and kill the whole
  // getHidden response.
  callback: async ({ userId }) =>
    await dbRead.$queryRaw<{ id: number; name: string }[]>`
        SELECT t.id, t.name
        FROM "TagEngagement" te
        JOIN "Tag" t ON t.id = te."tagId"
        WHERE te."userId" = ${userId}
          AND te.type = ${TagEngagementType.Hide}::"TagEngagementType"
      `,
});

// images hidden by toggling 'hide image'
export const HiddenImages = createUserCache({
  key: 'hidden-images-3',
  callback: async ({ userId }) =>
    (
      await dbRead.imageEngagement.findMany({
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
  const votedHideImages = await dbRead.tagsOnImageVote.findMany({
    where: { userId, tagId: { in: allHidden }, vote: { gt: 0 }, applied: false },
    select: { imageId: true, tagId: true },
  });

  // TODO.Briant
  /*
    Instead of returning every image the user has voted on that matches their hidden preferences, only return the images the user has voted on where the tag hasn't been applied to the image yet (due to scoring, moderator controls)
    tagsOnImageDetails.disabled indicates that the tag isn't applied
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
      await dbRead.modelEngagement.findMany({
        where: { userId, type: UserEngagementType.Hide },
        select: { modelId: true },
      })
    ).map((x) => x.modelId),
});

// Per-user `Hide` engagements on Model3D rows. Mirrors HiddenModels but
// against the `Model3DEngagement` table (`Model3DEngagementType.Hide` is
// already in the prisma enum, no migration required).
export const HiddenModel3Ds = createUserCache({
  key: 'hidden-model3ds-1',
  callback: async ({ userId }) =>
    (
      await dbRead.model3DEngagement.findMany({
        where: { userId, type: 'Hide' },
        select: { model3dId: true },
      })
    ).map((x) => x.model3dId),
});

export const HiddenUsers = createUserCache({
  key: 'hidden-users-4',
  callback: async ({ userId }) =>
    await dbRead.$queryRaw<{ id: number; username: string | null }[]>`
        SELECT
          ue."targetUserId" "id",
          u."username"
        FROM "UserEngagement" ue
        JOIN "User" u ON u."id" = ue."targetUserId"
        WHERE ue."userId" = ${userId} AND ue.type = ${UserEngagementType.Hide}::"UserEngagementType"
      `,
});

export const BlockedUsers = createUserCache({
  key: 'blocked-users-2',
  callback: async ({ userId }) =>
    await dbRead.$queryRaw<{ id: number; username: string | null }[]>`
        SELECT
          ue."targetUserId" "id",
          u."username"
        FROM "UserEngagement" ue
        JOIN "User" u ON u."id" = ue."targetUserId"
        WHERE ue."userId" = ${userId} AND ue.type = ${UserEngagementType.Block}::"UserEngagementType"
      `,
});

export const BlockedByUsers = createUserCache({
  key: 'blocked-by-users-2',
  callback: async ({ userId }) =>
    await dbRead.$queryRaw<{ id: number; username: string | null }[]>`
        SELECT
          ue."userId" "id",
          u."username"
        FROM "UserEngagement" ue
        JOIN "User" u ON u."id" = ue."userId"
        WHERE ue."targetUserId" = ${userId} AND ue.type = ${UserEngagementType.Block}::"UserEngagementType"
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

interface HiddenModel3D extends HiddenPreferenceBase {
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
  | ({ kind: 'model3d' } & HiddenModel3D)
  | ({ kind: 'image' } & HiddenImage)
  | ({ kind: 'user' } & HiddenUser)
  | ({ kind: 'blockedUser' } & HiddenUser);

interface HiddenPreferencesDiff {
  added: Array<HiddenPreferencesKind>;
  removed: Array<HiddenPreferencesKind>;
}

export type HiddenPreferenceTypes = {
  hiddenTags: HiddenTag[];
  hiddenUsers: HiddenUser[];
  hiddenModels: HiddenModel[];
  hiddenModel3Ds: HiddenModel3D[];
  hiddenImages: HiddenImage[];
  blockedUsers: HiddenUser[];
  blockedByUsers: HiddenUser[];
};

const getAllHiddenForUsersCached = async ({
  userId = -1, // Default to civitai account
}: {
  userId?: number;
}) => {
  // ONE HGETALL pulls every hidden-preference field for this user (previously
  // 7 individual GETs via packed.mGet's per-key fan-out — the largest Redis
  // contributor on the feed path), alongside the global moderated-tags blob.
  // Absent fields fall back per-pref to the DB via each cache's get() (see
  // createUserCache).
  const [hashFields, cachedModeratedTags] = await withSpan(
    'user-preferences:getAllHidden:redisFetch',
    () =>
      Promise.all([
        redis.packed.hGetAll<unknown>(getUserPrefsHashKey(userId)),
        redis.packed.get<AsyncReturnType<typeof getModeratedTags>>(
          REDIS_KEYS.SYSTEM.MODERATED_TAGS
        ),
      ])
  );

  const getModerationTags = async () =>
    (cachedModeratedTags as AsyncReturnType<typeof getModeratedTags>) ??
    (await getModeratedTags());

  const getHiddenTags = async ({ userId }: { userId: number }) =>
    (hashFields[HiddenTags.field] as AsyncReturnType<typeof HiddenTags.get>) ??
    (await HiddenTags.get({ userId }));

  const getHiddenImages = async ({ userId }: { userId: number }) =>
    (hashFields[HiddenImages.field] as AsyncReturnType<typeof HiddenImages.get>) ??
    (await HiddenImages.get({ userId }));

  const getHiddenModels = async ({ userId }: { userId: number }) =>
    (hashFields[HiddenModels.field] as AsyncReturnType<typeof HiddenModels.get>) ??
    (await HiddenModels.get({ userId }));

  const getHiddenModel3Ds = async ({ userId }: { userId: number }) =>
    (hashFields[HiddenModel3Ds.field] as AsyncReturnType<typeof HiddenModel3Ds.get>) ??
    (await HiddenModel3Ds.get({ userId }));

  const getHiddenUsers = async ({ userId }: { userId: number }) =>
    (hashFields[HiddenUsers.field] as AsyncReturnType<typeof HiddenUsers.get>) ??
    (await HiddenUsers.get({ userId }));

  const getHiddenImplicitImages = async ({
    userId,
    hiddenTagIds,
    moderatedTagIds,
  }: {
    userId: number;
    hiddenTagIds: number[];
    moderatedTagIds: number[];
  }) =>
    (hashFields[ImplicitHiddenImages.field] as AsyncReturnType<typeof ImplicitHiddenImages.get>) ??
    (await ImplicitHiddenImages.get({ userId, hiddenTagIds, moderatedTagIds }));

  const getBlockedUsers = async ({ userId }: { userId: number }) =>
    (hashFields[BlockedUsers.field] as AsyncReturnType<typeof BlockedUsers.get>) ??
    (await BlockedUsers.get({ userId }));

  const getBlockedByUsers = async ({ userId }: { userId: number }) =>
    (hashFields[BlockedByUsers.field] as AsyncReturnType<typeof BlockedByUsers.get>) ??
    (await BlockedByUsers.get({ userId }));

  // Resolve the 8 base preferences — each is a no-op if cached, otherwise
  // hits the DB. Wrapped so we can attribute the cache-miss DB fallback
  // latency separately from the redis fan-out above.
  const [
    moderatedTags,
    hiddenTags,
    images,
    models,
    model3ds,
    users,
    blockedUsers,
    blockedByUsers,
  ] = await withSpan('user-preferences:getAllHidden:resolve', () =>
    Promise.all([
      getModerationTags(),
      getHiddenTags({ userId }),
      getHiddenImages({ userId }),
      getHiddenModels({ userId }),
      getHiddenModel3Ds({ userId }),
      getHiddenUsers({ userId }),
      getBlockedUsers({ userId }),
      getBlockedByUsers({ userId }),
    ])
  );

  const [implicitImages] = await Promise.all([
    getHiddenImplicitImages({
      userId,
      hiddenTagIds: hiddenTags.map((x) => x.id),
      moderatedTagIds: moderatedTags.map((x) => x.id),
    }),
  ]);

  return {
    moderatedTags,
    hiddenTags,
    images,
    models,
    model3ds,
    users,
    implicitImages,
    blockedUsers,
    blockedByUsers,
  };
};

const getAllHiddenForUserFresh = async ({ userId }: { userId: number }) => {
  const [
    moderatedTags,
    hiddenTags,
    images,
    models,
    model3ds,
    users,
    blockedUsers,
    blockedByUsers,
  ] = await Promise.all([
    getModeratedTags(),
    HiddenTags.get({ userId }),
    HiddenImages.get({ userId }),
    HiddenModels.get({ userId }),
    HiddenModel3Ds.get({ userId }),
    HiddenUsers.get({ userId }),
    BlockedUsers.get({ userId }),
    BlockedByUsers.get({ userId }),
  ]);

  const [implicitImages] = await Promise.all([
    ImplicitHiddenImages.get({
      userId,
      hiddenTagIds: hiddenTags.map((x) => x.id),
      moderatedTagIds: moderatedTags.map((x) => x.id),
    }),
  ]);

  return {
    moderatedTags,
    hiddenTags,
    images,
    models,
    model3ds,
    users,
    implicitImages,
    blockedUsers,
    blockedByUsers,
  };
};

export async function getAllHiddenForUser({
  userId = -1, // Default to civitai account
  refreshCache,
}: {
  userId?: number;
  refreshCache?: boolean;
}): Promise<HiddenPreferenceTypes> {
  const {
    moderatedTags,
    hiddenTags,
    images,
    models,
    model3ds,
    users,
    implicitImages,
    blockedUsers,
    blockedByUsers,
  } = refreshCache
    ? await getAllHiddenForUserFresh({ userId })
    : await getAllHiddenForUsersCached({ userId });

  const result = {
    hiddenImages: [...images.map((id) => ({ id, hidden: true })), ...implicitImages],
    hiddenModels: models.map((id) => ({ id, hidden: true })),
    hiddenModel3Ds: model3ds.map((id) => ({ id, hidden: true })),
    hiddenUsers: users.map((user) => ({ ...user, hidden: true })),
    hiddenTags: [...hiddenTags.map((tag) => ({ ...tag, hidden: true })), ...moderatedTags],
    blockedUsers: blockedUsers.map((user) => ({ ...user, hidden: true })),
    blockedByUsers: blockedByUsers.map((user) => ({ ...user, hidden: true })),
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
    case 'model3d':
      return await toggleHideModel3D({ userId, model3dId: data[0].id });
    case 'user':
      return await toggleHideUser({ userId, targetUserId: data[0].id, setTo: hidden });
    case 'tag':
      return await toggleHiddenTags({ tagIds: data.map((x) => x.id), hidden, userId });
    case 'blockedUser':
      return await toggleBlockUser({ targetUserId: data[0].id, userId });
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

// Hide / unhide a single Model3D for a viewer. Mirrors `toggleHideModel`
// using the `Model3DEngagement` table (Hide type already exists, so no
// migration required). Refreshes the per-user `HiddenModel3Ds` cache so the
// next feed fetch picks the new id up.
async function toggleHideModel3D({
  userId,
  model3dId,
}: {
  userId: number;
  model3dId: number;
}): Promise<HiddenPreferencesDiff> {
  const engagement = await dbWrite.model3DEngagement.findUnique({
    where: { userId_model3dId: { userId, model3dId } },
    select: { type: true },
  });

  if (!engagement)
    await dbWrite.model3DEngagement.create({ data: { userId, model3dId, type: 'Hide' } });
  else if (engagement.type === 'Hide')
    await dbWrite.model3DEngagement.delete({
      where: { userId_model3dId: { userId, model3dId } },
    });
  else
    await dbWrite.model3DEngagement.update({
      where: { userId_model3dId: { userId, model3dId } },
      data: { type: 'Hide' },
    });

  await HiddenModel3Ds.refreshCache({ userId });

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

  await userFollowsCache.refresh(userId);
  await HiddenUsers.refreshCache({ userId });

  return {
    added: [],
    removed: [],
  };
}

async function toggleBlockUser({
  userId,
  targetUserId,
  setTo,
}: {
  userId: number;
  targetUserId: number;
  setTo?: boolean;
}): Promise<HiddenPreferencesDiff> {
  if (targetUserId === userId) throw new Error('Cannot block yourself');
  if (targetUserId === -1) throw new Error('Cannot block civitai account');

  const engagement = await dbWrite.userEngagement.findUnique({
    where: { userId_targetUserId: { userId, targetUserId } },
    select: { type: true },
  });
  if (!engagement)
    await dbWrite.userEngagement.create({
      data: { userId, targetUserId, type: 'Block' },
    });
  else if (engagement.type === 'Block' && setTo !== true)
    await dbWrite.userEngagement.delete({
      where: { userId_targetUserId: { userId, targetUserId } },
    });
  else
    await dbWrite.userEngagement.update({
      where: { userId_targetUserId: { userId, targetUserId } },
      data: { type: 'Block' },
    });

  await userFollowsCache.refresh(userId);
  await BlockedUsers.refreshCache({ userId });
  await BlockedByUsers.refreshCache({ userId: targetUserId });

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
