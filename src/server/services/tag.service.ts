import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import type { SessionUser } from '~/types/session';
import { isDev } from '~/env/other';
import {
  styleTags,
  subjectTags,
  type TagVotableEntityType,
  type VotableTagModel,
} from '~/libs/tags';
import { CacheTTL, constants } from '~/server/common/constants';
import { NsfwLevel, TagSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  imageTagsCache,
  modelVotableTagsCache,
  tagCache as basicTagCache,
} from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type {
  AdjustTagsSchema,
  DeleteTagsSchema,
  GetTagsForReviewInput,
  GetTagsInput,
  GetVotableTagsSchema,
  GetVotableTagsSchema2,
  ModerateTagsSchema,
} from '~/server/schema/tag.schema';
import { getCategoryTags, getReplacedTagIds, getSystemTags } from '~/server/services/system-cache';
import { upsertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import {
  HiddenImages,
  HiddenModels,
  ImplicitHiddenImages,
} from '~/server/services/user-preferences.service';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { Flags } from '~/shared/utils/flags';
import { TagSource, TagTarget, TagType } from '~/shared/utils/prisma/enums';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { removeEmpty } from '~/utils/object-helpers';

const alwaysIncludeTags = [...styleTags, ...subjectTags];

type TagWithModelCount = { id: number; name: string; unfeatured: boolean; count: number };

// Cache key for `getTagWithModelCount`. `Tag.name` is `citext` (case-insensitive), so
// `WHERE "name" = $1` matches case-insensitively in the DB. We normalize the key to
// lowercase so `"Anime"`/`"anime"` dedup to ONE entry (matching citext semantics) — but
// we do NOT trim, because the DB WHERE is whitespace-SENSITIVE; trimming the key while
// the query stays untrimmed would let `" anime"` collide with the real `"anime"` entry
// and serve the wrong row. Mirrors `getTagPageSeoData`'s key normalization exactly.
// (JS `toLowerCase` folds ASCII the same way the DB collation's citext `lower()` does;
// exotic-Unicode case pairs could land in separate keys that each independently resolve
// to the same tag — correct output, marginally weaker dedup.)
const getTagWithModelCountCacheKey = (name: string) =>
  `${REDIS_KEYS.CACHES.TAG_WITH_MODEL_COUNT}:${name.toLowerCase()}` as `${typeof REDIS_KEYS.CACHES.TAG_WITH_MODEL_COUNT}:${string}`;

const queryTagWithModelCount = ({ name }: { name: string }) =>
  // No longer include count since we just have too many now...
  dbRead.$queryRaw<[TagWithModelCount]>`
    SELECT "id",
           "name",
           "unfeatured",
           0 as count
    FROM "Tag"
    WHERE "name" = ${name}
    GROUP BY "id", "name"
    LIMIT 1 OFFSET 0;
  `;

// Read-through cache over the near-static tag-name → {id,name,unfeatured,count:0} lookup.
// Output is byte-identical to the raw query (the cached `name` is the tag's ACTUAL
// stored-case DB name, not the normalized key). Bucket A: DB total-exec-time / call-count
// reduction only, no behaviour change — the DB runs ~4% CPU, so this is a pod-neutral
// cost/margin win, NOT a capacity win.
//
// Fail-open like `fetchThroughCache`: on any Redis error we degrade to the origin query
// (this is a hot path — ~2.5M calls/peak — so a Redis stall must not 500). No distributed
// stampede lock: the origin is a single-row indexed citext lookup (~0.4ms warm) that at
// worst runs once per name per TTL cluster-wide, so a brief cold-key stampede is trivially
// cheap — not worth the lock's added Redis round-trips on the hot read.
//
// NEGATIVE RESULTS ARE NOT CACHED (decision (a)): an unknown name always re-hits the DB,
// so a newly created/renamed tag becomes findable immediately (no create-then-view
// staleness). This also shrinks the invalidation surface to writers that change an
// EXISTING tag's cached shape — pure `tag.create` paths need no bust because a brand-new
// name had no cached (positive) entry.
export const getTagWithModelCount = async ({
  name,
}: {
  name: string;
}): Promise<TagWithModelCount[]> => {
  const key = getTagWithModelCountCacheKey(name);

  try {
    const cached = await redis.packed.get<TagWithModelCount[]>(key);
    if (cached) return cached;
  } catch {
    // Redis read degraded — fall through to the origin query (fail open).
  }

  const result = await queryTagWithModelCount({ name });

  if (result.length > 0) {
    try {
      await redis.packed.set(key, result, { EX: CacheTTL.hour });
    } catch {
      // Best-effort cache write; a Redis stall here never fails the request.
    }
  }

  return result;
};

// Bust a single tag-name key. Hard delete (not a staleness reset): because we never cache
// negatives, deleting the key means the next read re-queries and (finding the tag gone)
// leaves it uncached. Called by `deleteTags`.
const bustTagWithModelCountCache = async (name: string) => {
  try {
    await redis.del(getTagWithModelCountCacheKey(name));
  } catch {
    // Best-effort bust; the TTL bounds any residual staleness.
  }
};

export type TagPageSeoData = {
  count: number;
  models: {
    id: number;
    name: string;
    type: string;
    creator: string;
    stats: { downloadCount: number; thumbsUpCount: number };
  }[];
};

export async function getTagPageSeoData({ name }: { name: string }): Promise<TagPageSeoData> {
  const cacheKey = `${
    REDIS_KEYS.CACHES.TAG_PAGE_SEO
  }:${name.toLowerCase()}` as `${typeof REDIS_KEYS.CACHES.TAG_PAGE_SEO}:${string}`;

  return fetchThroughCache(
    cacheKey,
    async () => {
      const tag = await dbRead.tag.findFirst({
        where: { name },
        select: { id: true },
      });

      if (!tag) return { count: 0, models: [] };

      const [countResult, models] = await Promise.all([
        dbRead.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*) as count
          FROM "TagsOnModels" tom
          JOIN "Model" m ON m."id" = tom."modelId"
          WHERE tom."tagId" = ${tag.id}
            AND m."status" = 'Published'::"ModelStatus"
            AND m."availability" != 'Unsearchable'::"Availability"
        `,
        dbRead.$queryRaw<
          {
            id: number;
            name: string;
            type: string;
            creator: string;
            downloadCount: number;
            thumbsUpCount: number;
          }[]
        >`
          SELECT
            m."id",
            m."name",
            m."type",
            u."username" as "creator",
            COALESCE(mm."downloadCount", 0)::int as "downloadCount",
            COALESCE(mm."thumbsUpCount", 0)::int as "thumbsUpCount"
          FROM "TagsOnModels" tom
          JOIN "Model" m ON m."id" = tom."modelId"
          JOIN "User" u ON u."id" = m."userId"
          LEFT JOIN "ModelMetric" mm ON mm."modelId" = m."id"
          WHERE tom."tagId" = ${tag.id}
            AND m."status" = 'Published'::"ModelStatus"
            AND m."availability" != 'Unsearchable'::"Availability"
          ORDER BY COALESCE(mm."downloadCount", 0) DESC
          LIMIT 20
        `,
      ]);

      return {
        count: Number(countResult[0]?.count ?? 0),
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type,
          creator: m.creator,
          stats: {
            downloadCount: m.downloadCount,
            thumbsUpCount: m.thumbsUpCount,
          },
        })),
      };
    },
    { ttl: CacheTTL.day }
  );
}

export const getTag = ({ id }: { id: number }) => {
  return dbRead.tag.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      type: true,
    },
  });
};

// unused
export const getTagCountForImages = async (imageIds: number[]) => {
  if (!imageIds.length) return {};
  const results = await dbRead.$queryRaw<{ imageId: number; count: number }[]>`
    SELECT "public"."TagsOnImageDetails"."imageId",
           CAST(COUNT("public"."TagsOnImageDetails"."tagId") AS INTEGER) as count
    FROM "public"."TagsOnImageDetails"
    WHERE "public"."TagsOnImageDetails"."imageId" IN (${Prisma.join(imageIds)})
    GROUP BY "public"."TagsOnImageDetails"."imageId"
  `;

  return results.reduce((acc, { imageId, count }) => {
    acc[imageId] = count;
    return acc;
  }, {} as Record<number, number>);
};

export const getTags = async ({
  take,
  skip,
  types,
  entityType,
  query,
  modelId,
  excludedTagIds,
  unlisted = false,
  categories,
  sort,
  withModels = false,
  includeAdminTags = false,
  nsfwLevel,
  include,
  moderation,
}: Omit<GetTagsInput, 'limit' | 'page'> & {
  take?: number;
  skip?: number;
  includeAdminTags?: boolean;
}) => {
  const AND = [Prisma.sql`t."unlisted" = ${unlisted}`];

  // Exclude replaced tags
  // Yeah, it's a little weird that the toTagId is what we exclude, but it's for a consistent hierarchy elsewhere...
  const replacedTagIds = await getReplacedTagIds();
  if (replacedTagIds.length > 0) {
    AND.push(Prisma.sql`t.id NOT IN (${Prisma.join(replacedTagIds)})`);
  }

  if (query) AND.push(Prisma.sql`t."name" LIKE ${query + '%'}`);
  else {
    // When getting top tags,
    nsfwLevel = NsfwLevel.PG; // only get PG tags
    AND.push(Prisma.sql`NOT t.unfeatured`); // Exclude unfeatured tags
  }
  if (types?.length) AND.push(Prisma.sql`t."type"::text IN (${Prisma.join(types)})`);
  if (entityType)
    AND.push(Prisma.sql`t."target" && (ARRAY[${Prisma.join(entityType)}]::"TagTarget"[])`);
  if (modelId)
    AND.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "TagsOnModels" tom WHERE tom."tagId" = t."id" AND tom."modelId" = ${modelId})`
    );
  if (excludedTagIds && excludedTagIds.length > 0 && !query) {
    AND.push(Prisma.sql`t."id" NOT IN (${Prisma.join(excludedTagIds)})`);
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnTags" tot
      WHERE tot."toTagId" = t."id"
      AND tot."fromTagId" IN (${Prisma.join(excludedTagIds)})
      AND tot.type = 'Parent'
    )`);
  }

  const systemTags = await getSystemTags();
  const categoryTags = (
    entityType
      ? systemTags.filter((t) => entityType.some((et) => t.name === `${et} category`.toLowerCase()))
      : systemTags.filter((t) => t.name.endsWith('category'))
  ).map((x) => x.id);
  if (categories && categoryTags.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnTags" tot
      WHERE tot."toTagId" = t."id"
      AND tot."fromTagId" IN (${Prisma.join(categoryTags)})
    )`);
  }
  if (!includeAdminTags) {
    AND.push(Prisma.sql`t."adminOnly" = false`);
  }

  if (moderation === false) {
    AND.push(Prisma.sql`t.type != 'Moderation'`);
  }

  if (nsfwLevel) AND.push(Prisma.sql`(t."nsfwLevel" & ${nsfwLevel}) != 0`);

  if (!sort) {
    if (entityType?.includes(TagTarget.Model)) sort = TagSort.MostModels;
    else if (entityType?.includes(TagTarget.Image)) sort = TagSort.MostImages;
    else if (entityType?.includes(TagTarget.Post)) sort = TagSort.MostPosts;
    else if (entityType?.includes(TagTarget.Article)) sort = TagSort.MostArticles;
  }

  const tagsOrderBy: string[] = [];
  if (query) tagsOrderBy.push(`LENGTH(t."name")`);
  if (isDev) tagsOrderBy.push(`t."name"`); // can't be bothered to update TagRank in gen_seed
  // else if (sort === TagSort.MostImages) tagsOrderBy.push(`r."imageCountAllTimeRank"`); // We don't update image tag counts anymore
  else if (sort === TagSort.MostModels) tagsOrderBy.push(`m."modelCount" DESC NULLS LAST`);
  else if (sort === TagSort.MostPosts) tagsOrderBy.push(`m."postCount" DESC NULLS LAST`);
  else if (sort === TagSort.MostArticles) tagsOrderBy.push(`m."articleCount" DESC NULLS LAST`);
  else if (sort === TagSort.MostHidden) tagsOrderBy.push(`m."hiddenCount" DESC NULLS LAST`);
  const orderBy = tagsOrderBy.length ? tagsOrderBy.join(', ') : `t."name" ASC`;

  const isCategory =
    !categories && !!categoryTags?.length
      ? Prisma.sql`, EXISTS (
        SELECT 1 FROM "TagsOnTags"
        WHERE "fromTagId" IN (${Prisma.join(categoryTags)})
        AND "toTagId" = t.id
      ) "isCategory"`
      : Prisma.sql``;

  const isNsfwLevel = include?.includes('nsfwLevel')
    ? Prisma.sql`, COALESCE(
      (
          SELECT MAX(pt."nsfwLevel")
          FROM "TagsOnTags" tot
          JOIN "Tag" pt ON tot."fromTagId" = pt.id
          WHERE tot."toTagId" = t.id
      ),
      t."nsfwLevel") "nsfwLevel"`
    : Prisma.sql``;

  const tagsRaw = await dbRead.$queryRaw<
    { id: number; name: string; isCategory?: boolean; nsfwLevel?: number }[]
  >`
    SELECT t."id",
           t."name"
           ${isCategory}
           ${isNsfwLevel}
    FROM "Tag" t
      ${Prisma.raw(
        orderBy.includes('m.')
          ? `LEFT JOIN "TagMetric" m ON m."tagId" = t."id" AND m.timeframe = 'AllTime'`
          : ''
      )}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${take} OFFSET ${skip}
  `;

  const models: Record<number, number[]> = {};
  // if (withModels) {
  //   const modelTags = await dbRead.tagsOnModels.findMany({
  //     where: { tagId: { in: tagsRaw.map((t) => t.id) } },
  //     select: { tagId: true, modelId: true },
  //   });
  //   for (const { tagId, modelId } of modelTags) {
  //     if (!models[tagId]) models[tagId] = [];
  //     models[tagId].push(modelId);
  //   }
  // }

  const items = tagsRaw.map((t) =>
    removeEmpty({
      ...t,
      models: withModels ? models[t.id] ?? [] : undefined,
    })
  );

  // Removed 2025/10/16 because this is super expensive and
  // Nothing actually supports paging tags anyway...

  // const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
  //   SELECT COUNT(*)::int count
  //   FROM "Tag" t
  //   WHERE ${Prisma.join(AND, ' AND ')}
  // `;

  return { items };
};

// #region [tag voting]
// The ImageTag view already drops unlisted tags (`AND NOT t_1.unlisted` in its Tag
// lateral); ModelTag does not, so only the model path needs this. Mods keep them so
// they can see what content is flagged as.
async function stripUnlistedTags<T extends { id: number }>(
  tags: T[],
  isModerator: boolean
): Promise<T[]> {
  if (isModerator || !tags.length) return tags;
  const cached = await basicTagCache.fetch(tags.map((tag) => tag.id));
  return tags.filter((tag) => !cached[tag.id]?.unlisted);
}

export const getVotableTags = async ({
  userId,
  type,
  id,
  take = 100,
  isModerator = false,
}: GetVotableTagsSchema & {
  userId?: number;
  isModerator?: boolean;
}) => {
  let results: VotableTagModel[] = [];
  if (type === 'model') {
    // Static, user-independent read of the ModelTag composite view — cache-backed
    // (mirrors the image path's imageTagsCache). The per-user vote is merged below,
    // uncached, so nothing user-specific is cached here.
    const cached = await modelVotableTagsCache.fetch([id]);
    const tags = cached[id]?.tags ?? [];
    results.push(
      ...tags.map(({ tagId, tagName, tagType, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        nsfwLevel: 0,
        name: tagName,
      }))
    );
    if (userId) {
      const userVotes = await dbRead.tagsOnModelsVote.findMany({
        where: { modelId: id, userId },
        select: { tagId: true, vote: true },
      });

      for (const tag of results) {
        const userVote = userVotes.find((vote) => vote.tagId === tag.id);
        if (userVote) tag.vote = userVote.vote;
      }
    }
    results = await stripUnlistedTags(results, isModerator);
  } else if (type === 'image') {
    const voteCutoff = new Date(Date.now() + constants.tagVoting.voteDuration);

    // Fetch from cache
    const cachedData = await imageTagsCache.fetch(id);
    const cacheItem = cachedData[id];

    if (cacheItem) {
      const tags = cacheItem.tags.slice(0, take ?? 100);
      const hasWDTags = tags.some((x) => x.source === TagSource.WD14);
      results.push(
        ...tags
          .filter((x) => {
            if (x.source === TagSource.Rekognition && hasWDTags) {
              if (x.tagType === TagType.Moderation) return true;
              if (alwaysIncludeTags.includes(x.tagName)) return true;
              return false;
            }
            return true;
          })
          .map(({ tagId, tagName, tagType, tagNsfwLevel, source, ...tag }) => ({
            ...tag,
            id: tagId,
            type: tagType,
            nsfwLevel: tagNsfwLevel,
            name: tagName,
          }))
      );
    }
    if (userId) {
      const userVotes = await dbRead.tagsOnImageVote.findMany({
        where: { imageId: id, userId },
        select: { tagId: true, vote: true },
      });

      for (const tag of results) {
        const userVote = userVotes.find((vote) => vote.tagId === tag.id);
        if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
      }
    }
    results = results.filter(
      (tag) =>
        tag.concrete ||
        (tag.lastUpvote && tag.lastUpvote > voteCutoff) ||
        (tag.vote && tag.vote > 0) ||
        (tag.needsReview && isModerator)
    );
  }

  return results;
};

export async function getVotableImageTags({
  ids,
  user,
  nsfwLevel,
}: {
  ids: number[];
  user: SessionUser;
  nsfwLevel?: number;
}) {
  // Fetch from cache
  const cachedData = await imageTagsCache.fetch(ids);

  // Process cached data
  const allImageTags: (VotableTagModel & { imageId: number })[] = [];
  const nsfwLevelArray = nsfwLevel ? Flags.instanceToArray(nsfwLevel) : null;

  for (const imageId of ids) {
    const cacheItem = cachedData[imageId];
    if (!cacheItem) continue;

    const imageTags = cacheItem.tags.filter(
      (tag) => !nsfwLevelArray || nsfwLevelArray.includes(tag.tagNsfwLevel)
    );

    const hasWDTags = imageTags.some((x) => x.source === TagSource.WD14);
    const filteredTags = imageTags
      .filter((x) => {
        if (x.source === TagSource.Rekognition && hasWDTags) {
          if (x.tagType === TagType.Moderation) return true;
          if (alwaysIncludeTags.includes(x.tagName)) return true;
          return false;
        }
        return true;
      })
      .map(({ tagId, tagName, tagType, tagNsfwLevel, source, ...tag }) => ({
        ...tag,
        imageId,
        id: tagId,
        type: tagType,
        nsfwLevel: tagNsfwLevel,
        name: tagName,
      })) as (VotableTagModel & { imageId: number })[];

    allImageTags.push(...filteredTags);
  }

  const userVotes = await dbRead.tagsOnImageVote.findMany({
    where: { imageId: { in: ids }, userId: user.id },
    select: { tagId: true, vote: true },
  });

  for (const tag of allImageTags) {
    const userVote = userVotes.find((vote) => vote.tagId === tag.id);
    if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
  }

  return allImageTags;
}

// TODO - create function for getting model tag votes and then finish abstracting this fuction - replaces `getVotableTags`
export async function getVotableTags2({
  ids,
  user,
  type,
  nsfwLevel,
}: GetVotableTagsSchema2 & { user: SessionUser }) {
  const voteCutoff = new Date(Date.now() + constants.tagVoting.voteDuration);
  const tagsFn = type === 'image' ? getVotableImageTags : getVotableImageTags;
  const tags = await tagsFn({ ids, user, nsfwLevel });
  return tags.filter(
    (tag) =>
      tag.concrete ||
      (tag.lastUpvote && tag.lastUpvote > voteCutoff) ||
      (tag.vote && tag.vote > 0) ||
      (tag.needsReview && user.isModerator)
  );
}

type TagVotingInput = {
  userId: number;
  type: TagVotableEntityType;
  id: number;
  tags: number[] | string[];
  isModerator?: boolean;
};
const clearCache = async (userId: number, entityType: TagVotableEntityType) => {
  if (entityType === 'model') await HiddenModels.refreshCache({ userId });
  else if (entityType === 'image') {
    await HiddenImages.refreshCache({ userId });
    await ImplicitHiddenImages.refreshCache({ userId });
  }
};

export const removeTagVotes = async ({ userId, type, id, tags }: TagVotingInput) => {
  const voteTable = type === 'model' ? 'TagsOnModelsVote' : 'TagsOnImageVote';
  const isTagIds = typeof tags[0] === 'number';
  const tagCondition = isTagIds
    ? Prisma.sql`"tagId" = ANY(${tags as number[]}::int[])`
    : Prisma.sql`"tagId" IN (SELECT id FROM "Tag" WHERE "name" = ANY(${tags as string[]}::text[]))`;
  await dbWrite.$executeRaw(Prisma.sql`
    DELETE
    FROM "${Prisma.raw(voteTable)}"
    WHERE "userId" = ${userId}
      AND "${Prisma.raw(type)}Id" = ${id}
      AND ${tagCondition}
  `);

  await clearCache(userId, type);

  // Bust the votable-tags cache for the affected entity
  if (type === 'image') {
    await imageTagsCache.bust(id);
  } else if (type === 'model') {
    await modelVotableTagsCache.bust(id);
  }
};

const MODERATOR_VOTE_WEIGHT = 10;
const CREATOR_VOTE_WEIGHT = 3;
export const addTagVotes = async ({
  userId,
  type,
  id,
  tags,
  isModerator,
  vote,
}: TagVotingInput & { vote: number }) => {
  // Determine vote weight
  let isCreator = false;
  if (type === 'model') {
    const creator = await dbRead.model.findFirst({ where: { id }, select: { userId: true } });
    isCreator = creator?.userId === userId;
  } else if (type === 'image') {
    const creator = await dbRead.image.findFirst({ where: { id }, select: { userId: true } });
    isCreator = creator?.userId === userId;
  }
  let voteWeight = 1;
  if (isModerator) voteWeight = MODERATOR_VOTE_WEIGHT;
  else if (isCreator) voteWeight = CREATOR_VOTE_WEIGHT;

  vote *= voteWeight;
  const isTagIds = typeof tags[0] === 'number';
  const tagMatch = isTagIds
    ? Prisma.sql`"id" = ANY(${tags as number[]}::int[])`
    : Prisma.sql`"name" = ANY(${tags as string[]}::text[])`;
  const voteTable = type === 'model' ? 'TagsOnModelsVote' : 'TagsOnImageVote';
  await dbWrite.$executeRaw(Prisma.sql`
    INSERT INTO "${Prisma.raw(voteTable)}" ("userId", "tagId", "${Prisma.raw(type)}Id", "vote")
    SELECT ${userId},
           id,
           ${id},
           ${vote}
    FROM "Tag"
    WHERE ${tagMatch}
    ON CONFLICT ("userId", "tagId", "${Prisma.raw(type)}Id") DO UPDATE SET "vote"      = ${vote},
                                                               "createdAt" = NOW()
  `);

  // If voting up a tag
  if (vote > 0) {
    // Check if it's a moderation tag
    const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int "count"
      FROM "Tag"
      WHERE ${tagMatch}
        AND "type" = 'Moderation'
    `);
    if (count > 0) await clearCache(userId, type); // Clear cache if it is
  }

  // Bust the votable-tags cache for the affected entity
  if (type === 'image') {
    await imageTagsCache.bust(id);
  } else if (type === 'model') {
    await modelVotableTagsCache.bust(id);
  }
};
// #endregion

export const addTags = async ({ tags, entityIds, entityType, relationship }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagFilter = (alias: string) =>
    isTagIds
      ? Prisma.sql`${Prisma.raw(alias)}."id" = ANY(${castedTags as number[]}::int[])`
      : Prisma.sql`${Prisma.raw(alias)}."name" = ANY(${castedTags as string[]}::text[])`;

  if (entityType === 'model') {
    await dbWrite.$executeRaw(Prisma.sql`
      INSERT INTO "TagsOnModels" ("modelId", "tagId")
      SELECT m."id",
             t."id"
      FROM "Model" m
             JOIN "Tag" t ON ${tagFilter('t')}
      WHERE m."id" = ANY(${entityIds}::int[])
      ON CONFLICT DO NOTHING
    `);
    // The ModelTag view gives every TagsOnModels row a base score of 5 (independent
    // of votes), so a freshly-applied tag is immediately score>0 and would appear in
    // getVotableTags — bust so the votable-tags cache reflects it within the TTL.
    await modelVotableTagsCache.bust(entityIds);
  } else if (entityType === 'image') {
    const result = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>(Prisma.sql`
      SELECT i."id" AS "imageId",  t."id" AS "tagId"
      FROM "Image" i
      JOIN "Tag" t ON ${tagFilter('t')}
      WHERE i."id" = ANY(${entityIds}::int[]);
    `);
    await upsertTagsOnImageNew(
      result.map(({ imageId, tagId }) => ({
        imageId,
        tagId,
        automated: false,
        disabled: false,
        needsReview: false,
      }))
    );
  } else if (entityType === 'article') {
    await dbWrite.$executeRaw(Prisma.sql`
      INSERT INTO "TagsOnArticle" ("articleId", "tagId")
      SELECT a."id",
             t."id"
      FROM "Article" a
             JOIN "Tag" t ON ${tagFilter('t')}
      WHERE a."id" = ANY(${entityIds}::int[])
      ON CONFLICT DO NOTHING
    `);
  } else if (entityType === 'tag') {
    if (!relationship) throw new Error('Relationship must be specified for tag tagging');

    await dbWrite.$executeRaw(Prisma.sql`
      INSERT INTO "TagsOnTags" ("fromTagId", "toTagId", type)
      SELECT fromTag."id",
             toTag."id",
             ${relationship}::"TagsOnTagsType"
      FROM "Tag" toTag
             JOIN "Tag" fromTag ON ${tagFilter('fromTag')}
      WHERE toTag."id" = ANY(${entityIds}::int[])
      ON CONFLICT DO NOTHING
    `);

    // Bust cache for tag rules
    // The changes with Replace and Append are handled in the `apply-tag-rules` job
    if (relationship === 'Replace' || relationship === 'Append') {
      await redis.del(REDIS_KEYS.SYSTEM.TAG_RULES);
    }

    // Clear cache for affected system tags
    const systemTags = await getSystemTags();
    for (const tag of systemTags) {
      if (
        isTagIds
          ? !(castedTags as number[]).includes(tag.id)
          : !(castedTags as string[]).includes(tag.name)
      )
        continue;

      try {
        await redis.del(`${REDIS_KEYS.SYSTEM.CATEGORIES}:${tag.name.replace(' category', '')}`);
      } catch {}
    }
  }
};

export const findOrCreateTagsByName = async (tags: string[]) => {
  const uniqTags = uniq(tags.map((t) => t.toLowerCase().trim()));

  const foundTags = await dbWrite.tag.findMany({
    where: { name: { in: uniqTags } },
    select: { id: true, name: true },
  });

  const tagCache: { [p: string]: undefined | number } = Object.fromEntries(
    uniqTags.map((t) => [t, undefined])
  );

  for (const tag of foundTags) tagCache[tag.name] = tag.id;

  const newTags = Object.entries(tagCache)
    .filter(([, id]) => id === undefined)
    .map((t) => t[0]);
  if (newTags.length > 0) {
    // prisma...my dude. you really can't return the created rows?
    await dbWrite.tag.createMany({
      data: newTags.map((x) => ({
        name: x,
        type: TagType.UserGenerated,
        target: [TagTarget.Post],
      })),
    });
    const newFoundTags = await dbWrite.tag.findMany({
      where: { name: { in: newTags } },
      select: { id: true, name: true },
    });
    for (const tag of newFoundTags) {
      tagCache[tag.name] = tag.id;
    }
  }

  return tagCache;
};

export const disableTags = async ({ tags, entityIds, entityType }: AdjustTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagIdMatch = (col: string) =>
    isTagIds
      ? Prisma.sql`${Prisma.raw(`"${col}"`)} = ANY(${castedTags as number[]}::int[])`
      : Prisma.sql`${Prisma.raw(`"${col}"`)} IN (SELECT id FROM "Tag" WHERE "name" = ANY(${
          castedTags as string[]
        }::text[]))`;

  // TODO.fix "disabled" doesnt exist for TagsOnModels, is this being used?
  if (entityType === 'model') {
    await dbWrite.$executeRaw(Prisma.sql`
      UPDATE "TagsOnModels"
      SET "disabled" = true
      WHERE "modelId" = ANY(${entityIds}::int[])
        AND ${tagIdMatch('tagId')}
    `);
    // Precautionary: the ModelTag view does NOT currently filter on `disabled`, so this
    // has no effect on getVotableTags output today — but bust to stay correct if the
    // view ever starts honoring `disabled`, and to keep model mutations uniformly busting.
    await modelVotableTagsCache.bust(entityIds);
  } else if (entityType === 'image') {
    const toUpdate = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>(Prisma.sql`
      SELECT "imageId", "tagId"
      FROM "TagsOnImageDetails"
      WHERE "imageId" = ANY(${entityIds}::int[])
        AND ${tagIdMatch('tagId')}
    `);

    await upsertTagsOnImageNew(
      toUpdate.map(({ imageId, tagId }) => ({ imageId, tagId, disabled: true, needsReview: false }))
    );
  } else if (entityType === 'tag') {
    await dbWrite.$executeRaw(Prisma.sql`
      DELETE
      FROM "TagsOnTags"
      WHERE "toTagId" = ANY(${entityIds}::int[])
        AND ${tagIdMatch('fromTagId')}
    `);

    // Bust cache for tag rules (since we can't easily check the type)
    await redis.del(REDIS_KEYS.SYSTEM.TAG_RULES);
  }
};

export const moderateTags = async ({ entityIds, entityType, disable }: ModerateTagsSchema) => {
  if (entityType === 'model') {
    // We aren't doing user model tagging quite yet...
    throw new Error('Not implemented');
    // await dbWrite.$executeRawUnsafe(`
    //   UPDATE "TagsOnModels"
    //   SET "disabled" = ${disable}, "needsReview" = false
    //   WHERE "needsReview" = true AND "modelId" IN (${entityIds.join(', ')})
    // `);
  } else if (entityType === 'image') {
    const toUpdate = await dbWrite.$queryRawUnsafe<{ imageId: number; tagId: number }[]>(`
      SELECT "imageId", "tagId"
      FROM "TagsOnImageDetails"
      WHERE "needsReview" = true
        AND "imageId" IN (${entityIds.join(', ')});
    `);

    await upsertTagsOnImageNew(
      toUpdate.map(({ imageId, tagId }) => ({
        imageId,
        tagId,
        automated: false,
        disabled: disable,
        needsReview: false,
      }))
    );

    await imageTagsCache.bust(entityIds);
  }
};

export const deleteTags = async ({ tags }: DeleteTagsSchema) => {
  const isTagIds = typeof tags[0] === 'number';
  // Explicit cast to number[] or string[] to avoid type errors
  const castedTags = isTagIds ? (tags as number[]) : (tags as string[]);
  const tagMatch = isTagIds
    ? Prisma.sql`"id" = ANY(${castedTags as number[]}::int[])`
    : Prisma.sql`"name" = ANY(${castedTags as string[]}::text[])`;

  // Get affected images before deletion (cascade will delete ImageTag records)
  const affectedImages = await dbWrite.$queryRaw<{ imageId: number }[]>(Prisma.sql`
    SELECT DISTINCT "imageId"
    FROM "ImageTag"
    WHERE "tagId" IN (
      SELECT id FROM "Tag" WHERE ${tagMatch}
    )
  `);

  // Get affected models before deletion — the ModelTag view JOINs Tag, so deleting the
  // Tag row (cascading its TagsOnModels/TagsOnModelsVote rows) removes it from a model's
  // votable list. Read the view directly (mirrors the ImageTag query above).
  const affectedModels = await dbWrite.$queryRaw<{ modelId: number }[]>(Prisma.sql`
    SELECT DISTINCT "modelId"
    FROM "ModelTag"
    WHERE "tagId" IN (
      SELECT id FROM "Tag" WHERE ${tagMatch}
    )
  `);

  // Resolve the affected tag NAMES before deletion so we can bust the name-keyed
  // getTagWithModelCount cache. deleteTags accepts ids OR names; reading the stored names
  // here covers the id-input case and gives the exact stored case (the key is lowercased,
  // so either form maps to the same key — but this is the correct, unambiguous source).
  const affectedTags = await dbWrite.$queryRaw<{ name: string }[]>(Prisma.sql`
    SELECT "name" FROM "Tag" WHERE ${tagMatch}
  `);

  await dbWrite.$executeRaw(Prisma.sql`
    DELETE
    FROM "Tag"
    WHERE ${tagMatch}
  `);

  // Bust cache for affected images
  if (affectedImages.length > 0) {
    const imageIds = affectedImages.map((x) => x.imageId);
    await imageTagsCache.bust(imageIds);
  }

  // Bust cache for affected models
  if (affectedModels.length > 0) {
    const modelIds = affectedModels.map((x) => x.modelId);
    await modelVotableTagsCache.bust(modelIds);
  }

  // Bust the per-name getTagWithModelCount cache for every deleted tag (its cached row now
  // points at a gone tag). This is the ONLY app writer that mutates that cache's shape —
  // no app path renames a tag or flips `unfeatured` (see the PR body's invalidation surface).
  if (affectedTags.length > 0) {
    await Promise.all(affectedTags.map((t) => bustTagWithModelCountCache(t.name)));
  }
};

// unused
export const getTypeCategories = async ({
  type,
  excludeIds,
  limit,
  cursor,
}: {
  type: 'image' | 'model' | 'post' | 'article';
  excludeIds?: number[];
  limit?: number;
  cursor?: number;
}) => {
  let categories = await getCategoryTags(type);
  if (excludeIds) categories = categories.filter((c) => !excludeIds.includes(c.id));
  let start = 0;
  if (cursor) start = categories.findIndex((c) => c.id === cursor);
  if (limit) categories = categories.slice(start, start + limit);

  return categories;
};

export async function getTagsForReview({ limit, page, reviewType }: GetTagsForReviewInput) {
  const pagination = getPagination(limit, page);
  const fromClause = Prisma.sql`
    FROM "ImageTagForReview" it
      JOIN "Tag" t ON it."tagId" = t.id
      JOIN "Image" i ON it."imageId" = i.id
    WHERE i."needsReview" = ${reviewType}
  `;

  const [tags, { count }] = await dbRead.$transaction([
    dbRead.$queryRaw<{ id: number; name: string }[]>`
      SELECT DISTINCT ON (t.name)
        t.id, t.name
      ${fromClause}
      ORDER BY t.name
      LIMIT ${pagination.take} OFFSET ${pagination.skip}
    `,
    dbRead.$queryRaw<{ count: number }>`
      SELECT
        COUNT(DISTINCT t.id) AS count
      ${fromClause}
    `,
  ]);

  return getPagingData({ items: tags, count }, pagination.take, page);
}
