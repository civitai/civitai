import { Prisma } from '@prisma/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { getAutoFeatureUserId, isAutoFeaturedRow } from '~/server/common/auto-feature';
import { uniq, uniqBy } from 'lodash-es';
import type { SessionUser } from '~/types/session';
import { v4 as uuid } from 'uuid';
import { FEATURED_MODEL_COLLECTION_ID } from '~/server/common/constants';
import {
  ArticleSort,
  CollectionReviewSort,
  CollectionSort,
  ImageSort,
  ModelSort,
  NotificationCategory,
  NsfwLevel,
  PostSort,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { queueCollectionMembershipUpdate } from '~/server/services/collection-index-sync';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { recordChallengeEntrySubmitted } from '~/server/prom/challenge.metrics';
import { tagIdsForImagesCache, userCollectionCountCache } from '~/server/redis/caches';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import { userPreferencesSchema } from '~/server/schema/base.schema';
import type {
  AddCollectionItemInput,
  BulkSaveCollectionItemsInput,
  CollectionMetadataSchema,
  GetAllCollectionItemsSchema,
  GetAllCollectionsInfiniteSchema,
  GetAllUserCollectionsInputSchema,
  GetUserCollectionItemsByItemSchema,
  RemoveCollectionItemInput,
  SetCollectionItemNsfwLevelInput,
  SetItemScoreInput,
  UpdateCollectionCoverImageInput,
  UpdateCollectionItemsStatusInput,
  UpsertCollectionInput,
  SetCollectionAiReviewInput,
} from '~/server/schema/collection.schema';
import { collectionAiReviewSchema } from '~/server/schema/collection.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import type { UserMeta } from '~/server/schema/user.schema';
import { collectionsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import {
  collectionSelect,
  collectionWithoutImageSelect,
} from '~/server/selectors/collection.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import type { ArticleGetAll } from '~/server/services/article.service';
import { getArticles } from '~/server/services/article.service';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { getModeratedTags } from '~/server/services/system-cache';
import { applyTagRules, insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { getAllImages, enqueueImageIngestion } from '~/server/services/image.service';
import type { GetModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import {
  bustFeaturedModelsCache,
  getModelsWithImagesAndModelVersions,
} from '~/server/services/model.service';
import { createNotification } from '~/server/services/notification.service';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { sanitizeProvenance } from '~/server/services/orchestrator/remix-provenance';
import type { PostsInfiniteModel } from '~/server/services/post.service';
import { getPostsInfinite } from '~/server/services/post.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import {
  DETAIL_BACKED_REASONS,
  resolveRejectionCopy,
} from '~/shared/constants/collection-rejection.constants';
import type { CollectionItemRejectionReason, MediaType } from '~/shared/utils/prisma/enums';
import {
  ChallengeSource,
  CollectionContributorPermission,
  CollectionInviteStatus,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
  HomeBlockType,
  ImageIngestionStatus,
  MetricTimeframe,
  ModelStatus,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { assertUserChallengeAcceptingEntries } from '~/server/games/daily-challenge/challenge-entry-gate';
import { detachPostsFromCollection } from '~/server/services/collection-post-detach';
import { liveInviteWhere } from '~/server/services/collection-invite.utils';
import {
  collectionSupportsCollaborators,
  freeGrantBaseline,
  isCollaboratorRow,
} from '~/server/services/collection-permission.utils';

export type CollectionContributorPermissionFlags = {
  collectionId: number;
  read: boolean;
  write: boolean;
  writeReview: boolean;
  manage: boolean;
  follow: boolean;
  isContributor: boolean;
  isCollaborator: boolean;
  collaborationDisabled: boolean;
  isOwner: boolean;
  followPermissions: CollectionContributorPermission[];
  publicCollection: boolean;
  collectionType: CollectionType | null;
  collectionMode: CollectionMode | null;
};

// Collection random ordering utilities
// Generates an hourly seed for consistent random ordering across requests
function computeHourlySeed(): number {
  return Math.floor(Date.now() / (1000 * 60 * 60));
}

// Get the current random seed from Redis, or compute a new one
export async function getCollectionRandomSeed(): Promise<number> {
  // Fail open + wall-clock deadline: a Random-sorted collection view should
  // degrade to a locally-computed hourly seed, not 500/park, on a sysRedis blip.
  // computeHourlySeed() is the same value this function writes on a cache miss,
  // so a degraded read just skips the shared-cache round-trip.
  let cached: string | null;
  try {
    cached = await withSysReadDeadline(sysRedis.get(REDIS_SYS_KEYS.COLLECTION.RANDOM_SEED));
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getCollectionRandomSeed', err);
    return computeHourlySeed();
  }
  if (cached) return Number(cached);

  const seed = computeHourlySeed();
  // Store with 2 hour TTL to ensure it persists across the hour
  await sysRedis.set(REDIS_SYS_KEYS.COLLECTION.RANDOM_SEED, seed.toString(), { EX: 60 * 60 * 2 });
  return seed;
}

// Update the seed in Redis (called by the hourly job)
export async function updateCollectionRandomSeed(): Promise<number> {
  const seed = computeHourlySeed();
  await sysRedis.set(REDIS_SYS_KEYS.COLLECTION.RANDOM_SEED, seed.toString(), { EX: 60 * 60 * 2 });
  return seed;
}

export const getAllCollections = async <TSelect extends Prisma.CollectionSelect>({
  input: { limit, cursor, privacy, types, userId, sort, ids, modes, query },
  user,
  select,
}: {
  input: GetAllCollectionsInfiniteSchema;
  select: TSelect;
  user?: SessionUser;
}) => {
  if (privacy && !user?.isModerator) privacy = [CollectionReadConfiguration.Public];

  const orderBy: Prisma.CollectionFindManyArgs['orderBy'] = [{ createdAt: 'desc' }];
  if (sort === CollectionSort.MostContributors)
    orderBy.unshift({ contributors: { _count: 'desc' } });

  // Optional case-insensitive name search (additive — `query` is omitted by every
  // pre-existing caller, so `undefined` leaves the where clause byte-identical).
  const trimmedQuery = query?.trim();

  const collections = await dbRead.collection.findMany({
    take: limit,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      id: ids && ids.length > 0 ? { in: ids } : undefined,
      read: privacy && privacy.length > 0 ? { in: privacy } : CollectionReadConfiguration.Public,
      type: types && types.length > 0 ? { in: types } : undefined,
      userId,
      mode: modes && modes.length > 0 && user?.isModerator ? { in: modes } : undefined,
      name: trimmedQuery ? { contains: trimmedQuery, mode: 'insensitive' } : undefined,
    },
    select,
    orderBy,
  });

  return collections;
};

export async function getUserCollectionPermissionsByIds({
  ids,
  userId,
  isModerator,
}: {
  ids: number[];
  userId?: number;
  isModerator?: boolean;
}): Promise<CollectionContributorPermissionFlags[]> {
  if (ids.length === 0) return [];

  type CollectionPermissionRow = {
    id: number;
    read: CollectionReadConfiguration;
    write: CollectionWriteConfiguration;
    userId: number;
    type: CollectionType | null;
    mode: CollectionMode | null;
    contributorPermissions: CollectionContributorPermission[] | null;
    collaborationDisabledAt: Date | null;
    hasAcceptedSeat: boolean;
  };

  const collections = await dbRead.$queryRaw<CollectionPermissionRow[]>`
    SELECT
      c.id,
      c.read::"CollectionReadConfiguration" as "read",
      c.write::"CollectionWriteConfiguration" as "write",
      c."userId",
      c.type::"CollectionType" as "type",
      c.mode::"CollectionMode" as "mode",
      c."collaborationDisabledAt",
      ${
        userId
          ? Prisma.sql`cc.permissions as "contributorPermissions", ci.id IS NOT NULL as "hasAcceptedSeat"`
          : Prisma.sql`NULL as "contributorPermissions", false as "hasAcceptedSeat"`
      }
    FROM "Collection" c
    ${
      userId
        ? Prisma.sql`
          LEFT JOIN "CollectionContributor" cc ON cc."collectionId" = c.id AND cc."userId" = ${userId}
          LEFT JOIN "CollectionInvite" ci ON ci."collectionId" = c.id AND ci."userId" = ${userId}
            AND ci.status = ${CollectionInviteStatus.Accepted}::"CollectionInviteStatus"
        `
        : Prisma.empty
    }
    WHERE c.id IN (${Prisma.join(ids)})
  `;

  const collectionMap = new Map(collections.map((c) => [c.id, c]));

  const results = ids.map((id) => {
    const collection = collectionMap.get(id);

    if (!collection) {
      return createEmptyPermissions(id);
    }

    const permissions: CollectionContributorPermissionFlags = {
      collectionId: collection.id,
      read: false,
      write: false,
      writeReview: false,
      manage: false,
      follow: false,
      isContributor: false,
      isCollaborator: false,
      collaborationDisabled: !!collection.collaborationDisabledAt,
      isOwner: false,
      publicCollection: false,
      followPermissions: [],
      collectionType: collection.type,
      collectionMode: collection.mode,
    };

    if (
      collection.read === CollectionReadConfiguration.Public ||
      collection.read === CollectionReadConfiguration.Unlisted
    ) {
      permissions.read = true;
      permissions.follow = true;
      permissions.followPermissions.push(CollectionContributorPermission.VIEW);
      permissions.publicCollection = true;
    }

    if (collection.write === CollectionWriteConfiguration.Public) {
      permissions.follow = true;
      permissions.write = true;
      permissions.followPermissions.push(CollectionContributorPermission.ADD);
    }

    if (collection.write === CollectionWriteConfiguration.Review) {
      permissions.follow = true;
      permissions.writeReview = true;
      permissions.followPermissions.push(CollectionContributorPermission.ADD_REVIEW);
    }

    const freelyGranted = freeGrantBaseline(collection);

    if (collection.collaborationDisabledAt) {
      permissions.write = false;
      permissions.writeReview = false;
      permissions.followPermissions = permissions.followPermissions.filter(
        (p) =>
          p !== CollectionContributorPermission.ADD &&
          p !== CollectionContributorPermission.ADD_REVIEW
      );
    }

    if (!userId) {
      return permissions;
    }

    if (userId === collection.userId) {
      permissions.isOwner = true;
      permissions.manage = true;
      permissions.read = true;
      permissions.write = true;
    }

    if (isModerator && !permissions.isOwner) {
      permissions.manage = true;
      permissions.read = true;
      permissions.write = collection.write === CollectionWriteConfiguration.Public;
      permissions.writeReview = collection.write === CollectionWriteConfiguration.Review;
    }

    const contributorPermissions = collection.contributorPermissions;

    if (!contributorPermissions || permissions.isOwner) {
      return permissions;
    }

    permissions.isContributor = true;

    permissions.isCollaborator =
      collectionSupportsCollaborators(collection) &&
      isCollaboratorRow({
        permissions: contributorPermissions,
        freeBaseline: freelyGranted,
        hasAcceptedSeat: collection.hasAcceptedSeat,
      });

    if (contributorPermissions.includes(CollectionContributorPermission.VIEW)) {
      permissions.read = true;
    }

    // A contributor row that merely mirrors the free-tier grant (e.g. a follower auto-added
    // with the collection's own followPermissions) must not resurrect access the lapse block
    // just closed — only a grant beyond the free tier survives a lapse.
    if (
      contributorPermissions.includes(CollectionContributorPermission.ADD) &&
      (!collection.collaborationDisabledAt ||
        !freelyGranted.has(CollectionContributorPermission.ADD))
    ) {
      permissions.write = true;
    }

    if (
      contributorPermissions.includes(CollectionContributorPermission.ADD_REVIEW) &&
      (!collection.collaborationDisabledAt ||
        !freelyGranted.has(CollectionContributorPermission.ADD_REVIEW))
    ) {
      permissions.writeReview = true;
    }

    if (contributorPermissions.includes(CollectionContributorPermission.MANAGE)) {
      permissions.manage = true;
    }

    return permissions;
  });

  return results;
}

export async function getUserCollectionPermissionsById({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
}): Promise<CollectionContributorPermissionFlags> {
  const results = await getUserCollectionPermissionsByIds({ ids: [id], userId, isModerator });
  return results[0] ?? createEmptyPermissions(id);
}

// The exact permissions array a follow row is written with for a given read/write pair.
// Order matters — the contributor resync compares it against stored rows with `equals` — so it
// must stay identical to the order `getUserCollectionPermissionsByIds` builds
// `followPermissions` in above.
function freeGrantPermissions(collection: {
  read: CollectionReadConfiguration;
  write: CollectionWriteConfiguration;
}): CollectionContributorPermission[] {
  const permissions: CollectionContributorPermission[] = [];
  if (collection.read !== CollectionReadConfiguration.Private) {
    permissions.push(CollectionContributorPermission.VIEW);
  }
  if (collection.write === CollectionWriteConfiguration.Public) {
    permissions.push(CollectionContributorPermission.ADD);
  }
  if (collection.write === CollectionWriteConfiguration.Review) {
    permissions.push(CollectionContributorPermission.ADD_REVIEW);
  }
  return permissions;
}

// Where a new entry lands. The queue is for the public: everyone the collection has actually
// vouched for — the owner, its managers, and the collaborators it invited — posts straight through.
//
// `writeReview` alone can't express that. It is granted to EVERYONE on a write:Review collection,
// the owner included, so reading it by itself put the people who work the queue into their own
// queue: production carries 108 items a collection's own owner submitted and never approved, the
// oldest from 2025-01-03. `isCollaborator` is the invited half, and it is false on contest and
// system collections, so contest entries keep going to review.
export function submissionStatus(
  permission: Pick<
    CollectionContributorPermissionFlags,
    'writeReview' | 'manage' | 'isOwner' | 'isCollaborator'
  >
): CollectionItemStatus {
  const vouchedFor = permission.manage || permission.isOwner || permission.isCollaborator;
  return permission.writeReview && !vouchedFor
    ? CollectionItemStatus.REVIEW
    : CollectionItemStatus.ACCEPTED;
}

function createEmptyPermissions(collectionId: number): CollectionContributorPermissionFlags {
  return {
    collectionId,
    read: false,
    write: false,
    writeReview: false,
    manage: false,
    follow: false,
    isContributor: false,
    isCollaborator: false,
    collaborationDisabled: false,
    isOwner: false,
    publicCollection: false,
    followPermissions: [],
    collectionType: null,
    collectionMode: null,
  };
}

type CollectionForPermission = {
  id: number;
  name: string;
  description?: string;
  read: CollectionReadConfiguration;
  userId: number;
  write: CollectionWriteConfiguration;
  imageId?: number;
  type?: CollectionType;
  mode?: CollectionMode | null;
};

export const getUserCollectionsWithPermissions = async <
  TSelect extends Prisma.CollectionSelect = Prisma.CollectionSelect
>({
  input,
}: {
  input: GetAllUserCollectionsInputSchema & { userId: number };
}) => {
  const {
    userId,
    permission,
    contributingOnly = true,
    includeActiveContests = false,
    contestModelId,
  } = input;
  let { permissions = [] } = input;
  // By default, owned collections will be always returned
  const AND: Prisma.Sql[] = [];
  const SELECT: Prisma.Sql = Prisma.raw(
    `SELECT c."id", c."name", c."description", c."read", c."userId", c."write", c."imageId", c."type", c."mode", c."createdAt", c."updatedAt"`
  );

  if (input.type) {
    AND.push(Prisma.sql`(c."type" = ${input.type}::"CollectionType" OR c."type" IS NULL)`);
  }

  // When surfacing active contests, Contest-mode collections must come ONLY through the
  // ownership+window-gated branch below — never via the contributor/public-read branches, which
  // carry no ownership or submission-window check and would leak followed or closed contests into
  // the picker for models the user doesn't own. Off for non-model callers, leaving the normal
  // follow flow untouched. Owned contests still surface via the owned-collections branch (query 1).
  const excludeContests = includeActiveContests
    ? Prisma.sql`AND c."mode" IS DISTINCT FROM ${CollectionMode.Contest}::"CollectionMode"`
    : Prisma.empty;

  const queries: Prisma.Sql[] = [
    Prisma.sql`(
      ${SELECT}
      FROM "Collection" c
      WHERE "userId" = ${userId}
        ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}

    )`,
  ];

  if (
    permissions &&
    permissions.includes(CollectionContributorPermission.ADD) &&
    !contributingOnly
  ) {
    queries.push(Prisma.sql`
      ${SELECT}
      FROM "Collection" c
      WHERE "write" = ${CollectionWriteConfiguration.Public}::"CollectionWriteConfiguration"
          ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}
    `);
  }

  if (
    permissions &&
    permissions.includes(CollectionContributorPermission.VIEW) &&
    !contributingOnly
  ) {
    // Even with view permission we don't really
    // want to return unlisted unless the user is a contributor
    // with that permission
    queries.push(Prisma.sql`
      ${SELECT}
      FROM "Collection" c
      WHERE "read" = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"
        ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}
        ${excludeContests}

    `);
  }

  permissions = [...permissions, permission].filter(isDefined);

  if (permissions.length > 0) {
    queries.push(Prisma.sql`(
        ${SELECT}
        FROM "CollectionContributor" AS cc
        JOIN "Collection" AS c ON c."id" = cc."collectionId"
        WHERE cc."userId" = ${userId}
          AND cc."permissions" && ARRAY[${Prisma.raw(
            permissions.map((p) => `'${p}'`).join(',')
          )}]::"CollectionContributorPermission"[]
          AND cc."collectionId" IS NOT NULL
          ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}
          ${excludeContests}
    )`);
  }

  // Active-window contest collections the user can submit to for review WITHOUT following first.
  // Contest + Review-write + Public-read, with a real submission window that is open RIGHT NOW.
  // A defined, in-future submissionEndDate is REQUIRED: without it we'd surface every windowless
  // contest ever created (old contests / daily challenges store no submission dates). Start date,
  // if present, must have passed. Kept independent of contributor joins so it also surfaces
  // contests the user hasn't joined; UNION de-dupes any that already appear via the branches above.
  // Gated on the user owning the target model: you can only submit your own models to a contest,
  // so a non-owned model (or an absent contestModelId) fails closed and surfaces nothing.
  if (includeActiveContests && contestModelId) {
    queries.push(Prisma.sql`(
        ${SELECT}
        FROM "Collection" c
        WHERE c."mode" = ${CollectionMode.Contest}::"CollectionMode"
          AND c."write" = ${CollectionWriteConfiguration.Review}::"CollectionWriteConfiguration"
          AND c."read" = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"
          AND c."metadata"->>'submissionEndDate' IS NOT NULL
          AND (c."metadata"->>'submissionEndDate')::timestamptz >= now()
          AND (
            c."metadata"->>'submissionStartDate' IS NULL
            OR (c."metadata"->>'submissionStartDate')::timestamptz <= now()
          )
          AND EXISTS (
            SELECT 1 FROM "Model" m
            WHERE m."id" = ${contestModelId} AND m."userId" = ${userId}
          )
          ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}
        LIMIT 100
    )`);
  }

  // Moved to using raw queries because of huge performance issues with Prisma.
  // Now we're doing Unions which makes it faster
  const db = await getDbWithoutLag('userCollections', userId);
  const collections = await db.$queryRaw<CollectionForPermission[]>`
    ${Prisma.join(queries, ' UNION ')}
  `;

  const collectionImageIds = collections.map((c) => c.imageId).filter(isDefined);

  const images =
    collectionImageIds.length > 0
      ? await dbRead.image.findMany({
          where: {
            id: {
              in: collectionImageIds,
            },
          },
        })
      : [];

  const collectionTags = await dbRead.tagsOnCollection.findMany({
    where: {
      collectionId: {
        in: collections.map((c) => c.id),
      },
    },
    include: {
      tag: true,
    },
  });

  // Someone else's collection needs to say whose it is — two people can name a collection the
  // same thing, and the picker offers collections the user neither owns nor follows.
  const ownerIds = Array.from(
    new Set(collections.map((c) => c.userId).filter((id) => id !== userId))
  );
  const ownerUsernames = new Map(
    ownerIds.length
      ? (
          await dbRead.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, username: true },
          })
        ).map((owner) => [owner.id, owner.username])
      : []
  );

  // Return user collections first && add isOwner  property
  return collections
    .map((collection) => ({
      ...collection,
      isOwner: collection.userId === userId,
      ownerUsername: ownerUsernames.get(collection.userId) ?? null,
      image: images.find((i) => i.id === collection.imageId),
      tags: collectionTags
        .filter((t) => t.collectionId === collection.id)
        .map((t) => ({
          ...t.tag,
          filterableOnly: t.filterableOnly,
        })),
    }))
    .sort(({ userId: collectionUserId }) => (userId === collectionUserId ? -1 : 1));
};

export const getCollectionById = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;
  const db = await getDbWithoutLag('collection', id);
  const collection = await db.collection.findUnique({
    where: { id },
    select: {
      ...collectionSelect,
      user: { select: userWithCosmeticsSelect },
    },
  });
  if (!collection) throw throwNotFoundError(`No collection with id ${id}`);

  return {
    ...collection,
    nsfwLevel: collection.nsfwLevel as NsfwLevel,
    image: collection.image
      ? {
          ...collection.image,
          nsfwLevel: collection.image.nsfwLevel as NsfwLevel,
          meta: collection.image.meta as ImageMetaProps | null,
        }
      : null,
    metadata: (collection.metadata ?? {}) as CollectionMetadataSchema,
    tags: collection.tags.map((t) => ({
      ...t.tag,
      filterableOnly: t.filterableOnly,
    })),
  };
};

export const getPendingReviewCount = (collectionId: number) =>
  dbRead.collectionItem.count({
    where: { collectionId, status: CollectionItemStatus.REVIEW },
  });

const inputToCollectionType = {
  modelId: CollectionType.Model,
  articleId: CollectionType.Article,
  imageId: CollectionType.Image,
  postId: CollectionType.Post,
} as const;

/**
 * Apply a collection's configured `metadata.autoTagId` to the images just added to it.
 *
 * Runs AFTER the write and independently of `CollectionItemStatus`, so a submission
 * awaiting review is tagged the same as an accepted one — the point is to mark what was
 * submitted, not what a moderator kept.
 *
 * Takes the metadata rather than a collection id: both callers already hold the
 * collection in scope, and re-reading it would add a query to every image submission on
 * the site for a field almost no collection sets.
 *
 * `insertTagsOnImageNew` handles cache busting and the search-index push that feed
 * filtering depends on, so nothing else needs syncing here.
 *
 * Never throws into the caller: a failed tag must not fail (or roll back) the
 * submission itself.
 */
async function applyCollectionAutoTag(
  metadata: CollectionMetadataSchema | null | undefined,
  imageIds: number[]
) {
  const tagId = metadata?.autoTagId;
  if (!tagId || !imageIds.length) return;

  try {
    // Defense in depth. `upsertCollection` already restricts `autoTagId` to moderators,
    // because nothing in the save path validates that the submitter OWNS the images —
    // so a self-owned collection plus someone else's imageIds would otherwise write tags
    // onto a stranger's content. A moderated tag is the sharp end of that: it drives
    // `updateImageNsfwLevels` and could push another user's image out of view.
    //
    // Tested against `getModeratedTags()` — what `updateImageNsfwLevels` itself gates on.
    // `Tag.type === 'Moderation'` is NOT the same set: it misses ~37 prod tags that are
    // moderated via `nsfwLevel > PG` or by inheriting a Parent edge, so checking type
    // would look like a guard while letting all of them through.
    //
    // Resolved through `applyTagRules` FIRST, because a TagsOnTags rule can rewrite a
    // permitted tag into a moderated one (~36 such rules in prod) — checking the raw
    // `autoTagId` would pass while a moderated row still lands. Test what actually gets
    // written, not what was configured. Both lookups are in-proc memoized.
    const resolved = await applyTagRules(
      imageIds.map((imageId) => ({ imageId, tagId, source: 'User' as const }))
    );
    const moderatedTagIds = await getModeratedTags().then((tags) => tags.map((t) => t.id));
    const offending = resolved.find((t) => moderatedTagIds.includes(t.tagId));
    if (offending) {
      logToAxiom({
        type: 'warning',
        name: 'collection-auto-tag-refused',
        message: 'autoTagId resolves to a moderated tag',
        tagId,
        resolvedTagId: offending.tagId,
      }).catch();
      return;
    }

    await insertTagsOnImageNew(
      [...new Set(imageIds)].map((imageId) => ({
        imageId,
        tagId,
        source: 'User' as const,
        confidence: 100,
        automated: true,
      }))
    );
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'collection-auto-tag-failed',
      message: (error as Error).message,
      tagId,
      imageIds: imageIds.slice(0, 20),
    }).catch();
  }
}

export const saveItemInCollections = async ({
  input: {
    collections: upsertCollectionItems,
    type,
    userId,
    isModerator,
    removeFromCollectionIds,
    canAccessUserChallenges,
    ...input
  },
}: {
  input: AddCollectionItemInput & {
    userId: number;
    isModerator?: boolean;
    canAccessUserChallenges?: boolean;
  };
}) => {
  const itemKey = Object.keys(inputToCollectionType).find((key) =>
    input.hasOwnProperty(key)
  ) as keyof typeof inputToCollectionType;
  if (!itemKey) throw throwBadRequestError(`We don't know the type of thing you're adding`);
  // Safeguard against duppes.
  upsertCollectionItems = uniqBy(upsertCollectionItems, 'collectionId');
  removeFromCollectionIds = uniq(removeFromCollectionIds);

  const collections = await dbRead.collection.findMany({
    select: collectionWithoutImageSelect,
    where: {
      id: { in: upsertCollectionItems.map((c) => c.collectionId) },
    },
  });

  if (itemKey && inputToCollectionType.hasOwnProperty(itemKey)) {
    const type = inputToCollectionType[itemKey];
    // check if all collections match the Model type
    const filteredCollections = collections.filter((c) => c.type === type || c.type == null);

    if (filteredCollections.length !== upsertCollectionItems.length) {
      throw throwBadRequestError('Collection type mismatch');
    }
  }

  // Every collection this request touches, in one lookup — the adds need it to spot no-op re-submissions
  // (below) and the removes need each item's id and author. Keyed on the item column alone: `input` also
  // carries `note`, and spreading it into the filter made a save-with-note silently match nothing.
  const touchedCollectionIds = uniq([
    ...upsertCollectionItems.map((c) => c.collectionId),
    ...removeFromCollectionIds,
  ]);
  const existingItems = await dbRead.collectionItem.findMany({
    where: { collectionId: { in: touchedCollectionIds }, [itemKey]: input[itemKey] },
    select: { id: true, collectionId: true, tagId: true, addedById: true, note: true },
  });
  const existingItemsByCollection = new Map(existingItems.map((item) => [item.collectionId, item]));

  // Collections the item is ALREADY in with the same tag — the upsert below writes nothing for these.
  // Callers may send the item's whole desired membership rather than just the additions, and re-running
  // the contest gates on an existing entry fails the save to an UNRELATED collection as soon as one of
  // those entries sits in a contest whose submission window has closed (or whose per-user cap it already
  // counts against). A tag CHANGE is a real write, so it still validates.
  const unwrittenCollectionIds = new Set(
    upsertCollectionItems
      .filter((upsert) => {
        const item = existingItemsByCollection.get(upsert.collectionId);
        return item && (upsert.tagId ?? null) === (item.tagId ?? null);
      })
      .map((upsert) => upsert.collectionId)
  );

  // Check if any contest collections are involved and validate ONCE
  const contestCollections = collections.filter(
    (c) => c.mode === CollectionMode.Contest && !unwrittenCollectionIds.has(c.id)
  );
  if (contestCollections.length > 0) {
    // Validate once for all contest collections instead of in the loop
    for (const contestCollection of contestCollections) {
      await validateContestCollectionEntry({
        metadata: (contestCollection.metadata ?? {}) as CollectionMetadataSchema,
        collectionId: contestCollection.id,
        userId,
        isModerator,
        canAccessUserChallenges,
        [`${itemKey}s`]: [input[itemKey]],
      });
    }
  }

  // Check if any featured collections are involved and validate ONCE
  const featuredCollections = collections.filter(
    (c) =>
      c.userId === -1 && !c.mode && c.name.includes('Featured') && !unwrittenCollectionIds.has(c.id)
  );
  if (featuredCollections.length > 0) {
    // Validate once for all featured collections instead of in the loop
    await validateFeaturedCollectionEntry({
      [`${itemKey}s`]: [input[itemKey]],
    });
  }

  // Batch fetch all permissions upfront instead of in the loop (N queries → 1 query), adds and removes
  // together — they're one round trip over the same table whether or not this request does both.
  const permissionsArray = await getUserCollectionPermissionsByIds({
    ids: touchedCollectionIds,
    userId,
    isModerator,
  });
  const permissionsMap = new Map(permissionsArray.map((p) => [p.collectionId, p]));

  // Submitting to a collection you don't already follow follows it — but that's a side effect of the
  // entry landing, so it's collected here and applied after the write. Doing it inline left a user
  // following collections they never joined whenever the save went on to write nothing (no write
  // permission on any of them, or the empty-transaction guard below).
  const followCollectionIds: number[] = [];

  const data = (
    await Promise.all(
      upsertCollectionItems.map(async (upsertCollection) => {
        const { collectionId, tagId } = upsertCollection;
        const collection = collections.find((c) => c.id === collectionId);

        if (!collection) {
          return null;
        }

        const inputTags = collection.tags?.filter((t) => !t.filterableOnly);

        if (
          inputTags.length > 0 &&
          !tagId &&
          !(collection.metadata as CollectionMetadataSchema)?.disableTagRequired
        ) {
          throw throwBadRequestError('Collection requires a tag');
        }

        if (collection.tags.length === 0 && tagId) {
          throw throwBadRequestError('Provided tag is not part of this collection');
        }

        if (
          collection.tags.length > 0 &&
          tagId &&
          !collection.tags.some((t) => t.tag.id === tagId)
        ) {
          throw throwBadRequestError('Provided tag is not part of this collection');
        }

        // Use batched permissions instead of individual query
        const permission = permissionsMap.get(collectionId);
        if (!permission) {
          return null;
        }

        if (!permission.writeReview && !permission.write) {
          return null;
        }

        // Queued rather than written: applied once the entry is actually in. `follow`/`manage` is what
        // addContributorToCollection would throw on, and a missing grant must not fail a save that has
        // already succeeded — so an ineligible collection is simply not followed. Skipping anyone who
        // already holds a row also keeps the upsert, which REPLACES permissions, off a collaborator's seat.
        const metadata = (collection.metadata ?? {}) as CollectionMetadataSchema;
        if (
          !permission.isContributor &&
          !permission.isOwner &&
          !metadata?.disableFollowOnSubmission &&
          (permission.follow || permission.manage)
        ) {
          followCollectionIds.push(collectionId);
        }

        return {
          addedById: userId,
          collectionId,
          status: submissionStatus(permission),
          [itemKey]: input[itemKey],
          tagId,
        };
      })
    )
  ).filter(isDefined);

  const transactions: Prisma.PrismaPromise<Prisma.BatchPayload | number>[] = [];
  let removedCount = 0;

  if (data.length > 0) {
    transactions.push(
      dbWrite.$executeRaw`
      INSERT INTO "CollectionItem" ("collectionId", "addedById", "status", "${Prisma.raw(
        itemKey
      )}", "tagId")
      SELECT
        v."collectionId",
        v."addedById",
        v."status",
        v."${Prisma.raw(itemKey)}",
        v."tagId"
      FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS v(
        "collectionId" INTEGER,
        "addedById" INTEGER,
        "status" "CollectionItemStatus",
        "${Prisma.raw(itemKey)}" INTEGER,
        "tagId" INTEGER
      )
      ON CONFLICT ("collectionId", "${Prisma.raw(itemKey)}")
        WHERE "${Prisma.raw(itemKey)}" IS NOT NULL
        DO UPDATE SET "tagId" = EXCLUDED."tagId";
    `
    );
  }

  if (removeFromCollectionIds?.length) {
    const removeAllowedCollectionItemIds = removeFromCollectionIds
      .map((collectionId) => {
        const permission = permissionsMap.get(collectionId);
        const item = existingItemsByCollection.get(collectionId);
        if (!permission || !item) {
          return null;
        }

        if (item.addedById !== userId && !permission.isOwner && !permission.manage) {
          // This person shouldn't cannot be removing that item
          return null;
        }

        return item.id;
      })
      .filter(isDefined);

    // The "Save to collection" modal is the other door into removal, and a delete through it
    // would let the job re-add the image the removal was meant to stop.
    const autoFeatureUserId = await getAutoFeatureUserId();
    const autoFeaturedIds = removeAllowedCollectionItemIds.filter((id) => {
      const item = existingItems.find((i) => i.id === id);
      return !!item && isAutoFeaturedRow(item, autoFeatureUserId);
    });
    const deletableIds = removeAllowedCollectionItemIds.filter(
      (id) => !autoFeaturedIds.includes(id)
    );

    removedCount = removeAllowedCollectionItemIds.length;

    if (autoFeaturedIds.length > 0) {
      transactions.push(
        dbWrite.collectionItem.updateMany({
          where: { id: { in: autoFeaturedIds } },
          data: {
            status: CollectionItemStatus.REJECTED,
            reviewedById: userId,
            reviewedAt: new Date(),
          },
        })
      );
    }

    // if we have items to remove, add a deleteMany mutation to the transaction
    if (deletableIds.length > 0) {
      transactions.push(
        dbWrite.collectionItem.deleteMany({
          where: { id: { in: deletableIds } },
        })
      );
    }
  }

  // The user requested at least one add or remove, but every item was filtered
  // out by permission/existence checks. Surface this so the UI can show an error
  // instead of a misleading success toast (see ClickUp 868jefmuv).
  if (transactions.length === 0) {
    throw throwAuthorizationError(
      'No changes were made — the selected collection(s) may no longer exist or you may not have permission to modify them.'
    );
  }

  await dbWrite.$transaction(transactions);

  if (followCollectionIds.length > 0) {
    await Promise.all(
      followCollectionIds.map((collectionId) =>
        addContributorToCollection({
          targetUserId: userId,
          userId,
          collectionId,
          permissionFlags: permissionsMap.get(collectionId),
        })
      )
    );
  }

  if (itemKey === 'imageId' && input.imageId) {
    const imageId = input.imageId;
    for (const { collectionId } of data) {
      const collection = collections.find((c) => c.id === collectionId);
      await applyCollectionAutoTag(collection?.metadata as CollectionMetadataSchema | null, [
        imageId,
      ]);
    }
  }

  const reviewCollectionIds = uniq(
    data.filter((d) => d.status === CollectionItemStatus.REVIEW).map((d) => d.collectionId)
  );
  if (reviewCollectionIds.length > 0) {
    try {
      const managers = await dbRead.collectionContributor.findMany({
        where: {
          collectionId: { in: reviewCollectionIds },
          permissions: { has: CollectionContributorPermission.MANAGE },
        },
        select: { collectionId: true, userId: true },
      });

      await Promise.all(
        reviewCollectionIds.map((collectionId) => {
          const collection = collections.find((c) => c.id === collectionId);
          if (!collection) return;

          const recipients = uniq([
            collection.userId,
            ...managers.filter((m) => m.collectionId === collectionId).map((m) => m.userId),
          ]).filter((id) => id !== userId);
          if (recipients.length === 0) return;

          return createNotification({
            userIds: recipients,
            type: 'collection-submission-received',
            category: NotificationCategory.Update,
            key: `collection-submission-received:${collectionId}:${uuid()}`,
            details: { collectionId, collectionName: collection.name },
          });
        })
      );
    } catch (error) {
      // The item write above already committed — a failure resolving recipients or notifying
      // them must not fail the submit itself, or the caller sees an error for an action that
      // actually succeeded and is likely to retry and double-submit.
      logToAxiom({
        type: 'error',
        name: 'collection-submission-notify-failed',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        collectionIds: reviewCollectionIds,
      }).catch(() => {
        // swallow — best-effort logging must never break the submit it is observing
      });
    }
  }

  // The feed index carries collection membership for hubs, and nothing about a
  // CollectionItem write reaches it on its own. Covers both directions: the
  // collections written to, and the ones the item was removed from, which are
  // only knowable from what was read before the write.
  if (input.imageId)
    await queueCollectionMembershipUpdate({
      collectionIds: [
        ...new Set([...collections.map((c) => c.id), ...existingItems.map((i) => i.collectionId)]),
      ],
      imageIds: [input.imageId],
    });

  // Check for updates to featured models
  if (input.modelId && collections.some((c) => c.id === FEATURED_MODEL_COLLECTION_ID)) {
    await bustFeaturedModelsCache();
    const versions = await dbRead.modelVersion.findMany({
      where: { id: input.modelId },
      select: { id: true },
    });
    await bustOrchestratorModelCache(versions.map((x) => x.id));
  }

  // Clear cache for homeBlocks
  await Promise.all(
    upsertCollectionItems.map((item) =>
      homeBlockCacheBust(HomeBlockType.Collection, item.collectionId)
    )
  );

  // Update collection search index
  const affectedCollections = [
    ...upsertCollectionItems.map((item) => item.collectionId),
    ...removeFromCollectionIds,
  ];
  if (affectedCollections.length > 0) {
    await collectionsSearchIndex.queueUpdate(
      affectedCollections.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

  return data.length > 0 ? 'added' : removedCount > 0 ? 'removed' : null;
};

export const upsertCollection = async ({
  input,
}: {
  input: UpsertCollectionInput & { userId: number; isModerator?: boolean; isMember?: boolean };
}) => {
  const {
    userId,
    isModerator,
    isMember,
    id,
    name,
    description,
    image,
    imageId,
    read,
    write,
    type,
    nsfw,
    mode,
    metadata,
    tags,
    ...collectionItem
  } = input;

  // `collectionItem.note` is NOT dead. `upsertCollectionInput` merges `collectionItemSchema`, so
  // `note` arrives from the client and reaches `items: { create: { ...collectionItem } }` below.
  // A grep for `note:` in a write position does not find it, because it is spread — this check was
  // deleted once on that evidence and had to be restored.
  await throwOnBlockedUserContent([name, description, collectionItem.note], {
    isModerator,
    surface: 'collection',
  });

  // `autoTagId` writes tag rows onto every image submitted to the collection, including
  // images the submitter doesn't own (nothing in the save path validates image
  // ownership). In a collection anyone can create and manage, that would let a user
  // stamp an arbitrary tag onto a stranger's image — and a MODERATED tag additionally
  // drives `updateImageNsfwLevels`, so it could raise someone else's image out of view.
  // Moderator-only. Every other field here only affects the collection itself.
  // Non-moderators can't set or change it, but the edit modal round-trips the whole
  // metadata blob — so rejecting on PRESENCE would 403 a co-manager who opened Edit and
  // hit Save without touching (or knowing about) the field. Pin it to the stored value
  // instead: their save becomes a no-op on this field rather than a wall.
  if (!isModerator && metadata) {
    const storedAutoTagId = id
      ? (
          (
            await dbRead.collection.findUnique({
              where: { id },
              select: { metadata: true },
            })
          )?.metadata as CollectionMetadataSchema | null
        )?.autoTagId
      : undefined;

    if (storedAutoTagId === undefined) delete metadata.autoTagId;
    else metadata.autoTagId = storedAutoTagId;
  }

  if (id) {
    const permission = await getUserCollectionPermissionsById({
      id,
      userId,
      isModerator,
    });
    if (!permission.manage) {
      throw throwAuthorizationError('You do not have permission to manage this collection');
    }

    // Get current collection values for comparison
    const currentCollection = await dbWrite.collection.findUnique({
      where: { id },
      select: {
        id: true,
        read: true,
        write: true,
        mode: true,
        createdAt: true,
        image: { select: { id: true } },
      },
    });
    if (!currentCollection) throw throwNotFoundError(`No collection with id ${id}`);

    const canConfigure = permission.isOwner || !!isModerator;
    const nextRead = canConfigure ? read : undefined;
    const nextWrite = canConfigure ? write : undefined;
    const nextMode = canConfigure ? mode : undefined;

    const opensSubmissions =
      !!nextWrite &&
      nextWrite !== currentCollection.write &&
      nextWrite !== CollectionWriteConfiguration.Private;

    if (opensSubmissions && !isMember && !isModerator) {
      throw throwAuthorizationError(
        'A membership is required to open a collection to submissions.'
      );
    }

    // nb - if we ever allow a cover image on create, copy this logic below
    // TODO commenting this out - other users can manage collections
    // const coverImgId = imageId ?? image?.id;
    // if (isDefined(coverImgId)) {
    //   const isImgOwner = await isImageOwner({ userId, isModerator, imageId: coverImgId });
    //   if (!isImgOwner) {
    //     throw throwAuthorizationError('Invalid cover image');
    //   }
    // }

    const updated = await dbWrite.$transaction(async (tx) => {
      if (tags) {
        // Attempt to run this first, collides with create/connect
        await tx.tagsOnCollection.deleteMany({
          where: {
            collectionId: id,

            tagId: {
              notIn: tags.filter(isTag).map((x) => x.id),
            },
          },
        });
      }

      const updated = await tx.collection.update({
        select: {
          id: true,
          mode: true,
          image: { select: { id: true, url: true, ingestion: true, type: true } },
          read: true,
          write: true,
          userId: true,
        },
        where: { id },
        data: {
          name,
          description,
          nsfw,
          read: nextRead,
          write: nextWrite,
          mode: nextMode,
          metadata: (metadata ?? {}) as Prisma.JsonObject,
          image: imageId
            ? { connect: { id: imageId } }
            : image !== undefined
            ? image === null
              ? { disconnect: true }
              : {
                  connectOrCreate: {
                    where: { id: image.id ?? -1 },
                    create: {
                      ...image,
                      meta:
                        (sanitizeProvenance(
                          image?.meta as Record<string, unknown> | null | undefined
                        ) as Prisma.JsonObject | undefined) ?? Prisma.JsonNull,
                      userId,
                      resources: undefined,
                      id: undefined,
                    },
                  },
                }
            : undefined,
          tags: tags
            ? {
                connectOrCreate: tags.filter(isTag).map((tag) => ({
                  where: { tagId_collectionId: { tagId: tag.id, collectionId: id as number } },
                  create: { tagId: tag.id },
                })),
                create: tags.filter(isNotTag).map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Collection] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });

      // No need to set randomId when changing to Contest mode - hash-based ordering is computed on-the-fly

      return updated;
    });

    // Count-cache refresh hits Redis — run it after the txn commits so it can't
    // add network latency to the interactive transaction's timeout budget.
    await userCollectionCountCache.refresh(updated.userId);

    if (nextRead === CollectionReadConfiguration.Public && currentCollection.read !== nextRead) {
      // Set publishedAt for all post belonging to this collection if changing privacy to public
      await dbWrite.$queryRaw`
        UPDATE "Post" SET
          "publishedAt" = COALESCE(DATE("metadata"->>'prevPublishedAt'), ${currentCollection.createdAt}, NOW()),
          "metadata" = jsonb_set("metadata", '{prevPublishedAt}', NULL)
        WHERE "collectionId" = ${updated.id}
      `;
    } else if (!updated.mode && nextRead !== CollectionReadConfiguration.Public) {
      // otherwise set publishedAt to null when no mode is setup.
      await dbWrite.$queryRaw`
        UPDATE "Post" SET
          "publishedAt" = NULL,
          "metadata" = jsonb_set("metadata", '{prevPublishedAt}', to_jsonb("publishedAt"))
        WHERE "collectionId" = ${updated.id}
      `;
    }

    // Follow rows carry whatever the collection granted for free when they were written, so
    // they have to be re-derived whenever that grant changes — otherwise closing a collection
    // leaves every follower holding ADD, which both keeps them writing to it and makes them
    // read as elevated collaborators to the roster. Compare against `currentCollection`, NOT
    // the post-update row: `updated.write` already holds the new value, so the condition was
    // false exactly when it needed to fire.
    if (
      (nextWrite && nextWrite !== currentCollection.write) ||
      (nextRead && nextRead !== currentCollection.read)
    ) {
      const previousFreeGrant = freeGrantPermissions(currentCollection);
      const permissions = freeGrantPermissions(updated);

      // An invited collaborator's grant is theirs, not the collection's — resetting it here
      // would revoke every collaborator the moment the owner touches privacy. Matches the
      // seat definition the caps and the roster use, so a re-invited collaborator (invite
      // flipped back to Pending) stays protected.
      const collaborators = await dbWrite.collectionInvite.findMany({
        where: liveInviteWhere(updated.id),
        select: { userId: true },
      });

      // Only rows that are EXACTLY the grant the collection used to hand out for free — i.e.
      // rows `addContributorToCollection` wrote from `followPermissions`. Rows carrying
      // anything else were granted by something other than following (an accepted invite, the
      // contest-manager join URL, historical staff rows), and this resync has never run in
      // production, so "not explicitly excluded" would silently revoke all of them.
      await dbWrite.collectionContributor.updateMany({
        where: {
          collectionId: updated.id,
          userId: { notIn: [updated.userId, ...collaborators.map((c) => c.userId)] },
          permissions: { equals: previousFreeGrant },
        },
        data: {
          permissions,
        },
      });
    }

    // Start image ingestion only if it's ingestion status is pending
    if (updated.image && updated.image.ingestion === ImageIngestionStatus.Pending) {
      enqueueImageIngestion({
        images: [updated.image as IngestImageInput],
        name: 'collection-image-ingest',
        userId,
      });
    }

    await collectionsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

    // nb: doing this will delete a user's own image
    // if (currentCollection.image && !input.image) {
    //   const isOwner = await isImageOwner({
    //     userId,
    //     isModerator,
    //     imageId: currentCollection.image.id,
    //   });
    //   if (isOwner) {
    //     await deleteImageById({ id: currentCollection.image.id });
    //   }
    // }

    await preventReplicationLag('collection', updated.id);

    return updated;
  }

  if (write && write !== CollectionWriteConfiguration.Private && !isMember && !isModerator) {
    throw throwAuthorizationError('A membership is required to open a collection to submissions.');
  }

  // TODO allow cover image
  const collection = await dbWrite.collection.create({
    select: {
      id: true,
      image: { select: { id: true, url: true } },
      read: true,
      write: true,
      userId: true,
      mode: true,
    },
    data: {
      name,
      description,
      nsfw,
      read,
      write,
      userId,
      type,
      mode,
      metadata: (metadata ?? {}) as Prisma.JsonObject,
      contributors: {
        create: {
          userId,
          permissions: [
            CollectionContributorPermission.MANAGE,
            CollectionContributorPermission.ADD,
            CollectionContributorPermission.VIEW,
          ],
        },
      },
      items: { create: { ...collectionItem, imageId, addedById: userId } },
      tags: tags
        ? {
            create: tags.map((tag) => {
              const name = tag.name.toLowerCase().trim();
              return {
                tag: {
                  connectOrCreate: {
                    where: { name },
                    create: { name, target: [TagTarget.Collection] },
                  },
                },
              };
            }),
          }
        : undefined,
    },
  });

  await userCollectionCountCache.refresh(userId);

  // Route subsequent reads to primary while the replica catches up so the
  // post-create redirect to /collections/[id] doesn't 404 on a fresh row.
  await Promise.all([
    preventReplicationLag('collection', collection.id),
    preventReplicationLag('userCollections', userId),
  ]);

  return collection;
};

export const updateCollectionCoverImage = async ({
  input,
}: {
  input: UpdateCollectionCoverImageInput & { userId: number; isModerator?: boolean };
}) => {
  const { id, imageId, userId, isModerator } = input;
  const permission = await getUserCollectionPermissionsById({
    id,
    userId,
    isModerator,
  });

  if (!permission.manage) {
    throw throwAuthorizationError('You do not have permission to manage this collection');
  }

  // TODO if necessary, check image ownership here

  const updated = await dbWrite.collection.update({
    select: { id: true, image: { select: { id: true, url: true, ingestion: true, type: true } } },
    where: { id },
    data: {
      image: { connect: { id: imageId } },
    },
  });

  if (!updated) throw throwNotFoundError(`No collection with id ${id}`);

  return updated;
};

interface ModelCollectionItem {
  type: 'model';
  data: GetModelsWithImagesAndModelVersions;
}

interface PostCollectionItem {
  type: 'post';
  data: PostsInfiniteModel;
}

interface ImageCollectionItem {
  type: 'image';
  data: ImagesInfiniteModel;
}

interface ArticleCollectionItem {
  type: 'article';
  data: ArticleGetAll[0];
}

export type CollectionItemExpanded = {
  id: number;
  status?: CollectionItemStatus;
  createdAt: Date | null;
  scores?: { userId: number; score: number }[] | null;
  rejectionReason?: CollectionItemRejectionReason | null;
  rejectionDetail?: string | null;
} & (ModelCollectionItem | PostCollectionItem | ImageCollectionItem | ArticleCollectionItem);

// Helper to parse cursor for collection items
// Format: "seed:sortKey:id" for contest random sort, or just "id" for other sorts
function parseCollectionCursor(cursor: string | undefined): {
  seed?: number;
  sortKey?: number;
  id?: number;
} {
  if (!cursor) return {};
  const parts = cursor.split(':');
  if (parts.length === 3) {
    return {
      seed: Number(parts[0]),
      sortKey: Number(parts[1]),
      id: Number(parts[2]),
    };
  }
  // Fallback: just an id
  return { id: Number(parts[0]) };
}

// Helper to create cursor for collection items
function createCollectionCursor(seed: number, sortKey: number, id: number): string {
  return `${seed}:${sortKey}:${id}`;
}

export type CollectionItemsResult = {
  items: CollectionItemExpanded[];
  nextCursor?: string;
};

// The AI review job stamps this as the reviewer on items it hands to a human.
export const AI_REVIEW_SYSTEM_USER_ID = -1;

export const getCollectionItemsByCollectionId = async ({
  input,
  user,
}: {
  input: UserPreferencesInput & GetAllCollectionItemsSchema;
  // Requires user here because models service uses it
  user?: SessionUser;
}): Promise<CollectionItemsResult> => {
  const {
    statuses = [CollectionItemStatus.ACCEPTED],
    limit = 50,
    collectionId,
    cursor,
    forReview,
    awaitingHumanReview,
    reviewSort,
    collectionTagId,
  } = input;

  const userPreferencesInput = userPreferencesSchema.parse(input);

  const permission = await getUserCollectionPermissionsById({
    id: input.collectionId,
    userId: user?.id,
    isModerator: user?.isModerator,
  });

  if (
    (forReview ||
      statuses.includes(CollectionItemStatus.REVIEW) ||
      statuses.includes(CollectionItemStatus.REJECTED)) &&
    !permission.isOwner &&
    !permission.manage
  ) {
    throw throwAuthorizationError('You do not have permission to view review items');
  }

  // Review flows read from the primary to avoid replica lag after accept/deny
  // mutations. Non-review callers stick with the read replica. The permission
  // check above ensures only owners/managers/moderators reach the primary.
  const itemDb = forReview ? dbWrite : dbRead;

  const collectionFindArgs = { where: { id: collectionId } } as const;
  const collection = await itemDb.collection.findUniqueOrThrow(collectionFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'collection', caller: 'getAllCollectionItems' });
    return dbWrite.collection.findUniqueOrThrow(collectionFindArgs);
  });

  const useRandomSort = !forReview && collection.mode === CollectionMode.Contest;

  // The system user stamps every item it touches, accept and reject included, so the stamp alone
  // means "the AI saw this". Only a stamped item still sitting in REVIEW is waiting on a person.
  const awaitingHumanCondition = awaitingHumanReview
    ? Prisma.sql`AND ci."reviewedById" = ${AI_REVIEW_SYSTEM_USER_ID} AND ci.status = 'REVIEW'::"CollectionItemStatus"`
    : Prisma.sql``;

  // For contest mode, use hash-based random ordering with cursor support
  let collectionItems: {
    id: number;
    modelId: number | null;
    postId: number | null;
    imageId: number | null;
    articleId: number | null;
    status?: CollectionItemStatus;
    createdAt: Date | null;
    scores?: { userId: number; score: number }[];
    sortKey?: number;
    rejectionReason?: CollectionItemRejectionReason | null;
    rejectionDetail?: string | null;
  }[];
  let currentSeed: number | undefined;

  if (useRandomSort) {
    // Parse cursor to get seed and position
    const parsedCursor = parseCollectionCursor(cursor);

    // Use seed from cursor for pagination continuity, or get current seed
    currentSeed = parsedCursor.seed ?? (await getCollectionRandomSeed());

    // Build the raw SQL query with hash-based ordering
    const statusArray = statuses.map((s) => `'${s}'`).join(', ');
    const tagCondition = collectionTagId
      ? Prisma.sql`AND ci."tagId" = ${collectionTagId}`
      : Prisma.sql``;
    const imageIngestionCondition =
      collection.type === CollectionType.Image
        ? Prisma.sql`AND (i."ingestion" = 'Scanned' OR i.id IS NULL)`
        : Prisma.sql``;

    // Cursor condition for pagination
    const cursorCondition =
      parsedCursor.sortKey !== undefined && parsedCursor.id !== undefined
        ? Prisma.sql`AND (
            abs(mod(hashtext(concat(ci.id::text, ${currentSeed.toString()})), 1000000000)) < ${
            parsedCursor.sortKey
          }
            OR (
              abs(mod(hashtext(concat(ci.id::text, ${currentSeed.toString()})), 1000000000)) = ${
            parsedCursor.sortKey
          }
              AND ci.id < ${parsedCursor.id}
            )
          )`
        : Prisma.sql``;

    const rawItems = await itemDb.$queryRaw<
      {
        id: number;
        modelId: number | null;
        postId: number | null;
        imageId: number | null;
        articleId: number | null;
        status: CollectionItemStatus;
        createdAt: Date | null;
        sortKey: number;
      }[]
    >`
      SELECT
        ci.id,
        ci."modelId",
        ci."postId",
        ci."imageId",
        ci."articleId",
        ci."status",
        ci."createdAt",
        abs(mod(hashtext(concat(ci.id::text, ${currentSeed.toString()})), 1000000000)) as "sortKey"
      FROM "CollectionItem" ci
      LEFT JOIN "Image" i ON ci."imageId" = i.id
      WHERE ci."collectionId" = ${collectionId}
        AND ci."status" IN (${Prisma.raw(statusArray)})
        ${tagCondition}
        ${awaitingHumanCondition}
        ${imageIngestionCondition}
        ${cursorCondition}
      ORDER BY "sortKey" DESC, ci.id DESC
      LIMIT ${limit + 1}
    `;

    collectionItems = rawItems;
  } else {
    // Determine sort direction
    let sortDirection: 'ASC' | 'DESC' = 'DESC';
    if (forReview && reviewSort === CollectionReviewSort.Oldest) {
      sortDirection = 'ASC';
    }

    // Parse simple cursor for non-random sort
    const parsedCursor = parseCollectionCursor(cursor);

    // Build SQL conditions
    const statusArray = statuses.map((s) => `'${s}'`).join(', ');
    const tagCondition = collectionTagId
      ? Prisma.sql`AND ci."tagId" = ${collectionTagId}`
      : Prisma.sql``;
    const imageIngestionCondition =
      collection.type === CollectionType.Image && !forReview
        ? Prisma.sql`AND i."ingestion" = 'Scanned'`
        : Prisma.sql``;

    // Cursor condition for compound ordering (createdAt, id)
    const cursorCondition = parsedCursor.id
      ? sortDirection === 'DESC'
        ? Prisma.sql`AND (
            ci."createdAt" < (SELECT "createdAt" FROM "CollectionItem" WHERE id = ${parsedCursor.id})
            OR (
              ci."createdAt" = (SELECT "createdAt" FROM "CollectionItem" WHERE id = ${parsedCursor.id})
              AND ci.id < ${parsedCursor.id}
            )
            OR ci."createdAt" IS NULL
          )`
        : Prisma.sql`AND (
            ci."createdAt" > (SELECT "createdAt" FROM "CollectionItem" WHERE id = ${parsedCursor.id})
            OR (
              ci."createdAt" = (SELECT "createdAt" FROM "CollectionItem" WHERE id = ${parsedCursor.id})
              AND ci.id < ${parsedCursor.id}
            )
            OR (SELECT "createdAt" FROM "CollectionItem" WHERE id = ${parsedCursor.id}) IS NULL
          )`
      : Prisma.sql``;

    // Execute raw SQL query
    const rawItems = await itemDb.$queryRaw<
      {
        id: number;
        modelId: number | null;
        postId: number | null;
        imageId: number | null;
        articleId: number | null;
        status: CollectionItemStatus | null;
        createdAt: Date | null;
        rejectionReason: CollectionItemRejectionReason | null;
        rejectionDetail: string | null;
      }[]
    >`
      SELECT
        ci.id,
        ci."modelId",
        ci."postId",
        ci."imageId",
        ci."articleId",
        ${forReview ? Prisma.sql`ci."status"::text as status,` : Prisma.sql``}
        ${
          forReview
            ? Prisma.sql`ci."rejectionReason"::text as "rejectionReason", ci."rejectionDetail",`
            : Prisma.sql``
        }
        ci."createdAt"
      FROM "CollectionItem" ci
      ${
        collection.type === CollectionType.Image
          ? Prisma.sql`LEFT JOIN "Image" i ON ci."imageId" = i.id`
          : Prisma.sql``
      }
      WHERE ci."collectionId" = ${collectionId}
        AND ci."status" IN (${Prisma.raw(statusArray)})
        ${tagCondition}
        ${awaitingHumanCondition}
        ${imageIngestionCondition}
        ${cursorCondition}
      ORDER BY ci."createdAt" ${Prisma.raw(sortDirection)}, ci.id DESC
      LIMIT ${limit + 1}
    `;

    // Handle scores separately if needed (forReview)
    if (forReview && user?.id) {
      const itemIds = rawItems.map((item) => item.id);
      const scores = await itemDb.collectionItemScore.findMany({
        where: {
          collectionItemId: { in: itemIds },
          userId: user.id,
        },
        select: {
          collectionItemId: true,
          userId: true,
          score: true,
        },
      });

      // Map scores to items
      collectionItems = rawItems.map((item) => ({
        ...item,
        status: item.status as CollectionItemStatus | undefined,
        scores: scores
          .filter((s) => s.collectionItemId === item.id)
          .map((s) => ({ userId: s.userId, score: s.score })),
      }));
    } else {
      collectionItems = rawItems.map((item) => ({
        ...item,
        status: item.status as CollectionItemStatus | undefined,
      }));
    }
  }

  // Determine next cursor
  let nextCursor: string | undefined;
  if (collectionItems.length > limit) {
    const lastItem = collectionItems[limit - 1]; // Get the actual last item (not the extra one)
    collectionItems = collectionItems.slice(0, limit); // Remove the extra item

    if (useRandomSort && currentSeed !== undefined && lastItem.sortKey !== undefined) {
      nextCursor = createCollectionCursor(currentSeed, lastItem.sortKey, lastItem.id);
    } else {
      nextCursor = lastItem.id.toString();
    }
  }

  if (collectionItems.length === 0) {
    return { items: [], nextCursor: undefined };
  }

  if (user && forReview) {
    user.isModerator = true;
  }

  const modelIds = collectionItems.map((item) => item.modelId).filter(isDefined);

  const models =
    modelIds.length > 0
      ? await getModelsWithImagesAndModelVersions({
          user,
          input: {
            limit: modelIds.length,
            sort: ModelSort.Newest,
            period: MetricTimeframe.AllTime,
            periodMode: 'stats',
            hidden: false,
            favorites: false,
            ...userPreferencesInput,
            ids: modelIds,
            browsingLevel: input.browsingLevel,
          },
        })
      : { items: [] };

  const articleIds = collectionItems.map((item) => item.articleId).filter(isDefined);

  const articles =
    articleIds.length > 0
      ? await getArticles({
          limit: articleIds.length,
          period: MetricTimeframe.AllTime,
          periodMode: 'stats',
          sort: ArticleSort.Newest,
          ...userPreferencesInput,
          browsingLevel: input.browsingLevel,
          sessionUser: user,
          ids: articleIds,
          include: ['cosmetics'],
        })
      : { items: [] };

  const imageIds = collectionItems.map((item) => item.imageId).filter(isDefined);

  const images =
    imageIds.length > 0
      ? await getAllImages({
          include: ['cosmetics', 'tagIds', 'profilePictures'],
          limit: imageIds.length,
          period: MetricTimeframe.AllTime,
          periodMode: 'stats',
          sort: ImageSort.Newest,
          ...userPreferencesInput,
          browsingLevel: input.browsingLevel,
          user,
          ids: imageIds,
          headers: { src: 'getCollectionItemsByCollectionId' },
          includeBaseModel: true,
          pending: forReview,
          withMeta: false,
          dbTarget: forReview ? 'write' : 'read',
        })
      : { items: [] };

  const postIds = collectionItems.map((item) => item.postId).filter(isDefined);

  const posts =
    postIds.length > 0
      ? await getPostsInfinite({
          limit: postIds.length,
          period: MetricTimeframe.AllTime,
          periodMode: 'published',
          sort: PostSort.Newest,
          ...userPreferencesInput,
          user,
          browsingLevel: input.browsingLevel,
          ids: postIds,
          include: ['cosmetics'],
        })
      : { items: [] };

  const collectionItemsExpanded: CollectionItemExpanded[] = collectionItems
    .map(({ imageId, postId, articleId, modelId, ...collectionItemRemainder }) => {
      if (modelId) {
        // Get all model info:
        const model = models.items.find((m) => m.id === modelId);
        if (!model) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'model' as const,
          data: model,
        };
      }

      if (postId) {
        const post = posts.items.find((p) => p.id === postId);

        if (!post) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'post' as const,
          data: post,
        };
      }

      if (imageId) {
        const image = images.items.find((i) => i.id === imageId);

        if (!image) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'image' as const,
          data: image,
        };
      }

      if (articleId) {
        const article = articles.items.find((a) => a.id === articleId);

        if (!article) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'article' as const,
          data: article,
        };
      }

      return null;
    })
    .filter(isDefined)
    .filter((collectionItem) => !!collectionItem.data);

  return { items: collectionItemsExpanded, nextCursor };
};

// Who authored the entity itself. `removeCollectionItem` lets an author pull their own work out of
// any collection, so the flag below has to account for them or the action is authorized on the
// server and missing from the UI.
async function getEntityOwnerId({
  modelId,
  imageId,
  articleId,
  postId,
}: {
  modelId?: number;
  imageId?: number;
  articleId?: number;
  postId?: number;
}): Promise<number | null> {
  const select = { userId: true };
  if (modelId) {
    const model = await dbRead.model.findUnique({ where: { id: modelId }, select });
    return model?.userId ?? null;
  }
  if (imageId) {
    const image = await dbRead.image.findUnique({ where: { id: imageId }, select });
    return image?.userId ?? null;
  }
  if (postId) {
    const post = await dbRead.post.findUnique({ where: { id: postId }, select });
    return post?.userId ?? null;
  }
  if (articleId) {
    const article = await dbRead.article.findUnique({ where: { id: articleId }, select });
    return article?.userId ?? null;
  }
  return null;
}

export const getUserCollectionItemsByItem = async ({
  input,
}: {
  input: GetUserCollectionItemsByItemSchema & { userId: number; isModerator?: boolean };
}) => {
  const { userId, isModerator, modelId, imageId, articleId, postId } = input;

  const userCollections = await getUserCollectionsWithPermissions({
    input: {
      permissions: [
        CollectionContributorPermission.ADD,
        CollectionContributorPermission.ADD_REVIEW,
        CollectionContributorPermission.MANAGE,
      ],
      userId,
    },
  });

  if (userCollections.length === 0) return [];

  const entityOwnerId = await getEntityOwnerId({ modelId, imageId, articleId, postId });
  const ownsEntity = entityOwnerId !== null && entityOwnerId === userId;

  const collectionItems = await dbRead.collectionItem.findMany({
    select: {
      collectionId: true,
      addedById: true,
      tagId: true,
      collection: {
        select: {
          userId: true,
          read: true,
        },
      },
    },
    where: {
      collectionId: {
        in: userCollections.map((c) => c.id),
      },
      OR: [{ modelId }, { imageId }, { postId }, { articleId }],
    },
  });

  return Promise.all(
    collectionItems.map(async (collectionItem) => {
      const permission = await getUserCollectionPermissionsById({
        id: collectionItem.collectionId,
        userId,
        isModerator,
      });

      return {
        ...collectionItem,
        canRemoveItem:
          collectionItem.addedById === userId || ownsEntity || permission.manage || !!isModerator,
      };
    })
  );
};

export const deleteCollectionById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) => {
  const collectionDeleteFindArgs = {
    // Confirm the collection belongs to the user:
    where: { id, userId: isModerator ? undefined : userId },
    select: { id: true, mode: true },
  } as const;
  const collection = await dbRead.collection
    .findFirstOrThrow(collectionDeleteFindArgs)
    .catch(() => {
      dbReadFallbackCounter.inc({ entity: 'collection', caller: 'deleteCollectionById' });
      return dbWrite.collection.findFirstOrThrow(collectionDeleteFindArgs);
    });

  if (collection.mode === CollectionMode.Bookmark) {
    throw throwBadRequestError('You cannot delete a bookmark collection');
  }

  await detachPostsFromCollection(id);

  const res = await dbWrite.collection.delete({ where: { id } });

  // UserHubSource.targetId is polymorphic, so there is no foreign key to cascade
  // through — a hub would keep pointing at a collection that no longer exists and
  // go on filtering the feed by its id. Removing the sources here is what makes
  // the now-unreachable membership left in the search index harmless.
  await dbWrite.userHubSource.deleteMany({
    where: { type: UserHubSourceType.Collection, targetId: id },
  });

  await collectionsSearchIndex.queueUpdate([
    {
      id,
      action: SearchIndexUpdateQueueAction.Delete,
    },
  ]);

  // Route subsequent reads to primary so the user's collection list and
  // any cached detail page see the deletion immediately (phantom collection fix).
  await Promise.all([
    preventReplicationLag('collection', id),
    preventReplicationLag('userCollections', userId),
  ]);

  return res;
};

export const addContributorToCollection = async ({
  collectionId,
  userId,
  targetUserId,
  permissions,
  permissionFlags,
}: {
  userId: number;
  targetUserId: number;
  collectionId: number;
  permissions?: CollectionContributorPermission[];
  /** The caller's flags for this collection, when it has already resolved them — skips the lookup. */
  permissionFlags?: CollectionContributorPermissionFlags;
}) => {
  // check if user can add contributors:
  const { followPermissions, manage, follow } =
    permissionFlags ?? (await getUserCollectionPermissionsById({ id: collectionId, userId }));

  if (!manage && !follow) {
    throw throwAuthorizationError(
      'You do not have permission to add contributors to this collection.'
    );
  }

  // The upsert REPLACES the target's permissions, so without this any follower of a
  // community collection could rewrite a manager's row and strip their MANAGE.
  // Mirrors removeContributorFromCollection's guard.
  if (targetUserId !== userId && !manage) {
    throw throwAuthorizationError(
      'You do not have permission to add contributors to this collection.'
    );
  }

  const contributorPermissions =
    permissions && permissions.length > 0 ? permissions : followPermissions;

  if (!contributorPermissions.length) {
    return; // Can't add this user as contributor due to lacking permissions.
  }

  return dbWrite.collectionContributor.upsert({
    where: { userId_collectionId: { userId: targetUserId, collectionId } },
    create: { userId: targetUserId, collectionId, permissions: contributorPermissions },
    update: { permissions: contributorPermissions },
  });
};

export const removeContributorFromCollection = async ({
  userId,
  targetUserId,
  collectionId,
}: {
  userId: number;
  targetUserId: number;
  collectionId: number;
}) => {
  const { manage } = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
  });

  if (!manage && targetUserId !== userId) {
    throw throwAuthorizationError(
      'You do not have permission to remove contributors from this collection.'
    );
  }
  try {
    return await dbWrite.collectionContributor.delete({
      where: {
        userId_collectionId: {
          userId: targetUserId,
          collectionId,
        },
      },
    });
  } catch {
    // Ignore errors
  }
};

export const getAvailableCollectionItemsFilterForUser = ({
  statuses,
  permissions,
  userId,
}: {
  statuses?: CollectionItemStatus[];
  permissions: CollectionContributorPermissionFlags;
  userId?: number;
}) => {
  const rawAND: Prisma.Sql[] = [];
  const AND: Prisma.Enumerable<Prisma.CollectionItemWhereInput> = [];

  // A user with relevant permissions can filter & manage these permissions
  if ((permissions.manage || permissions.isOwner) && statuses) {
    AND.push({ status: { in: statuses } });
    rawAND.push(
      Prisma.sql`ci."status" IN (${Prisma.raw(
        statuses.map((s) => `'${s}'::"CollectionItemStatus"`).join(',')
      )})`
    );

    return {
      AND,
      rawAND,
    };
  }

  if (userId) {
    AND.push({
      OR: [
        { status: CollectionItemStatus.ACCEPTED },
        { AND: [{ status: CollectionItemStatus.REVIEW }, { addedById: userId }] },
      ],
    });

    rawAND.push(
      Prisma.sql`(ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus" OR (ci."status" = ${CollectionItemStatus.REVIEW}::"CollectionItemStatus" AND ci."addedById" = ${userId}))`
    );
  } else {
    AND.push({ status: CollectionItemStatus.ACCEPTED });
    rawAND.push(Prisma.sql`ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus"`);
  }

  return { AND, rawAND };
};

export const COLLECTION_AI_REVIEW_KEY_PREFIX = 'collection-ai-review:';
export const collectionAiReviewKey = (collectionId: number) =>
  `${COLLECTION_AI_REVIEW_KEY_PREFIX}${collectionId}`;

// The prompt is deliberately not in the repo: it describes exactly which signals reject versus
// escalate, and this repository is public.
export const getCollectionAiReviewDefaultPrompt = async () => {
  const row = await dbRead.keyValue.findUnique({
    where: { key: `${COLLECTION_AI_REVIEW_KEY_PREFIX}default` },
    select: { value: true },
  });
  const value = row?.value as { prompt?: string } | null;
  return value?.prompt ?? '';
};

export const getCollectionAiReview = async (collectionId: number) => {
  const row = await dbRead.keyValue.findUnique({
    where: { key: collectionAiReviewKey(collectionId) },
    select: { value: true },
  });
  if (!row) return null;

  const parsed = collectionAiReviewSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
};

export const setCollectionAiReview = async ({
  collectionId,
  aiReview,
}: SetCollectionAiReviewInput) => {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, mode: true },
  });
  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);

  if (aiReview.enabled && collection.mode !== CollectionMode.Contest)
    throw throwBadRequestError('AI review can only be enabled on Contest collections.');

  const key = collectionAiReviewKey(collectionId);
  await dbWrite.keyValue.upsert({
    where: { key },
    create: { key, value: aiReview },
    update: { value: aiReview },
  });

  return aiReview;
};

export const updateCollectionItemsStatus = async ({
  input,
  userId,
  isModerator,
  isSystem,
  rejectionDetail,
}: {
  input: UpdateCollectionItemsStatusInput;
  userId: number;
  isModerator?: boolean;
  /**
   * In-process callers (the AI review job) act as the system user, which holds no contributor row.
   * Never accept this from a tRPC input.
   */
  isSystem?: boolean;
  /**
   * Free text shown to the submitter, for the reasons that have no fixed copy. Deliberately not
   * part of the wire schema: a reviewer writes about someone else's entry, so only the AI review
   * job supplies this. Never accept it from a tRPC input.
   */
  rejectionDetail?: string;
}) => {
  const { collectionId, collectionItemIds, status, rejectionReason } = input;

  const isRejection = status === CollectionItemStatus.REJECTED;
  const persistedReason = isRejection ? rejectionReason ?? null : null;
  // Only the detail-backed reasons ever read the detail back, so anything else would leave text
  // on the row that no surface displays.
  const persistedDetail =
    persistedReason && DETAIL_BACKED_REASONS.has(persistedReason)
      ? rejectionDetail?.trim() || null
      : null;
  const reason = resolveRejectionCopy({ reason: persistedReason, detail: persistedDetail });

  // Check if collection actually exists before anything
  const collection = await dbWrite.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, type: true, mode: true, name: true, metadata: true },
  });

  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);

  if (!isSystem) {
    const { manage, isOwner } = await getUserCollectionPermissionsById({
      id: collectionId,
      userId,
      isModerator,
    });

    if (!manage && !isOwner)
      throw throwAuthorizationError(
        'You do not have permissions to manage contributor item status.'
      );
  }

  const collectionMetadata = collection.metadata as CollectionMetadataSchema;

  if (status === CollectionItemStatus.ACCEPTED) {
    if (collectionMetadata?.judgesCanScoreEntries) {
      const exists = await dbRead.collectionItem.findFirst({
        where: {
          id: { in: collectionItemIds },
          scores: {
            none: {},
          },
        },
      });

      if (exists) {
        throw throwBadRequestError(
          'Some of the items selected do not have scores. Please ensure all items have scores before approving them.'
        );
      }
    }

    if (collectionMetadata?.judgesApplyBrowsingLevel && collection.type === CollectionType.Image) {
      const exists = await dbRead.collectionItem.findFirst({
        where: {
          id: { in: collectionItemIds },
          image: {
            nsfwLevel: {
              in: [0, -1],
            },
          },
        },
      });

      if (exists) {
        throw throwBadRequestError(
          'Some of the items selected have not been given a NSFW rating. Please ensure all items have a NSFW rating before approving them.'
        );
      }
    }
  }

  const isReviewOutcome =
    status === CollectionItemStatus.ACCEPTED || status === CollectionItemStatus.REJECTED;

  // Capture prior state before the status write so we only notify on real transitions.
  const priorItems =
    isReviewOutcome && collectionItemIds.length > 0
      ? await dbWrite.collectionItem.findMany({
          where: { id: { in: collectionItemIds }, collectionId },
          select: {
            id: true,
            addedById: true,
            status: true,
            rejectionReason: true,
            rejectionDetail: true,
            imageId: true,
            articleId: true,
            modelId: true,
            postId: true,
          },
        })
      : [];

  if (collectionItemIds.length > 0) {
    await dbWrite.$executeRaw`
      UPDATE "CollectionItem"
      SET "reviewedById" = ${userId},
      "reviewedAt" = ${new Date()},
      "updatedAt" = ${new Date()},
      "status" = ${status}::"CollectionItemStatus",
      "rejectionReason" = ${persistedReason}::"CollectionItemRejectionReason",
      "rejectionDetail" = ${persistedDetail}
      WHERE "collectionId" = ${collectionId} AND "id" IN (${Prisma.join(collectionItemIds)})
    `;
  }

  if (priorItems.length > 0) {
    const notificationType =
      status === CollectionItemStatus.ACCEPTED
        ? 'collection-item-accepted'
        : 'collection-item-rejected';

    await Promise.all(
      priorItems.map(async (item) => {
        // A re-reject rewrites the stored reason, so "same status" alone is not a no-op: without
        // the copy comparison the row would end up disagreeing with the sentence the submitter read.
        const isNoop =
          item.status === status &&
          resolveRejectionCopy({
            reason: item.rejectionReason,
            detail: item.rejectionDetail,
          }) === reason;

        // Skip missing submitter, self-review, and no-op reviews.
        if (!item.addedById || item.addedById === userId || isNoop) return;

        await createNotification({
          type: notificationType,
          userId: item.addedById,
          category: NotificationCategory.Update,
          key: `${notificationType}:${item.id}:${uuid()}`,
          details: {
            status,
            reason,
            collectionId: collection.id,
            collectionName: collection.name,
            imageId: item.imageId,
            articleId: item.articleId,
            modelId: item.modelId,
            postId: item.postId,
          },
        });
      })
    );
  }

  // Send back the collection to update/invalidate state accordingly
  return collection;
};

/**
 * Accepted-item counts per collection.
 *
 * `browsingLevel` is OPTIONAL and defaults to today's behaviour — omit it and the
 * emitted SQL is the unclamped query this function has always run (only the table
 * alias is new), so every existing caller is unaffected. Supply it and the result
 * is the CLAMPED count: how many items a viewer at that maturity ceiling can
 * actually see.
 *
 * 🔴 THE CLAMPED FORM IS EXACT AND EXPENSIVE — CHECK THE POPULATION BEFORE USING
 * IT. Unclamped, this is an Index Only Scan on the covering (collectionId, status)
 * index with no heap access; the clamp's join to "Image" forfeits that index and
 * becomes a nested loop over every accepted item. Measured on a production-scale
 * replica: 85 ms unclamped vs 2829 ms clamped over one App Blocks discovery
 * over-fetch window (97 collections, 298,469 accepted items). Its one production
 * caller is `mode=mine` of the blocks collections endpoint, whose population is
 * the subject's own already-sliced collections — bounded, and nothing like the
 * popularity-sorted discovery window. Public discovery deliberately does NOT use
 * it; it samples instead (`getCollectionPlayableSample`).
 *
 * 🔴 THIS FUNCTION IS NOT IMAGE-ONLY, AND THE CLAMP MUST NOT MAKE IT SO. The row
 * filter keeps anything with an `imageId` OR `modelId` OR `postId` OR `articleId`,
 * so model / post / article collections are counted here too. `nsfwLevel` lives on
 * `Image`, so an INNER `JOIN "Image"` would silently return 0 for every one of
 * those collections. Hence a LEFT JOIN plus an explicit `ci."imageId" IS NULL`
 * escape: a non-image item has no image maturity to test and is kept
 * unconditionally.
 *
 * An item whose `imageId` points at a row that no longer exists yields a NULL
 * `nsfwLevel`, and both halves of the bitwise test are NULL → the item is NOT
 * counted. That is deliberate and fail-closed: an image we cannot rate is one we
 * cannot promise is playable, and it matches `getFallbackCoverImages`, whose
 * inner join drops the same row.
 *
 * The maturity test itself is BITWISE (`nsfwLevel & browsingLevel != 0`, plus
 * unrated 0) — the identical authority the images service, the collection detail
 * path and `getFallbackCoverImages` use. A `<=` would be wrong: level 29 is a
 * mixed bucket that intersects a SFW ceiling.
 */
export function getCollectionItemCount({
  collectionIds: ids,
  status,
  browsingLevel,
}: {
  collectionIds: number[];
  status?: CollectionItemStatus;
  browsingLevel?: number;
}) {
  if (ids.length === 0) return [] as { id: number; count: number }[];

  const where = [Prisma.sql`ci."collectionId" IN (${Prisma.join(ids)})`];
  if (status) where.push(Prisma.sql`ci."status" = ${status}::"CollectionItemStatus"`);
  // `!= null`, NOT truthiness: a ceiling of 0 is a real (if degenerate) ceiling
  // that permits only unrated items, and `if (browsingLevel)` would silently read
  // it as "no clamp" — i.e. return the FULL count for the most restrictive viewer.
  if (browsingLevel != null)
    where.push(
      Prisma.sql`(ci."imageId" IS NULL OR (i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)`
    );

  // Joined only when clamping, so the unclamped plan every existing caller relies
  // on is untouched.
  const join =
    browsingLevel != null ? Prisma.sql`LEFT JOIN "Image" i ON i."id" = ci."imageId"` : Prisma.empty;

  return dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT ci."collectionId" as "id", COUNT(*) as "count"
    FROM "CollectionItem" ci
    ${join}
    WHERE ${Prisma.sql`${Prisma.join(where, ' AND ')}`}
      AND (ci."imageId" IS NOT NULL OR ci."modelId" IS NOT NULL OR ci."postId" IS NOT NULL OR ci."articleId" IS NOT NULL)
    GROUP BY ci."collectionId"
  `;
}

export function getContributorCount({ collectionIds: ids }: { collectionIds: number[] }) {
  if (ids.length === 0) return [] as { id: number; count: number }[];

  const where = [Prisma.sql`"collectionId" IN (${Prisma.join(ids)})`];

  return dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT "collectionId" as "id", COUNT(*) as "count"
    FROM "CollectionContributor"
    WHERE ${Prisma.sql`${Prisma.join(where, ' AND ')}`}
    GROUP BY "collectionId"
  `;
}

// Charge the active user-challenge entry fee for `imageIds` on this collection, if any.
// Idempotent per (challenge, image) — see chargeEntryFees. No-op for empty input or collections
// without an Active fee challenge. Returns the paid/unpaid partition when a charge ran; entry
// fees are NEVER refunded (see challenge-funding.ts), so callers must commit only
// `paidImageIds` — an unpaid image self-heals if the user retries.
//
// Moderators are charged like everyone else: a fee-exempt entry is still eligible to win, so it
// would pay out from a pool it never funded (challenge 413 completed with 2 mod entries and a
// prizePool of 0).
const chargeContestEntryFeesForCollection = async ({
  collectionId,
  userId,
  imageIds,
}: {
  collectionId: number;
  userId: number;
  imageIds: number[];
}) => {
  if (imageIds.length === 0) return undefined;
  // Look up the active source=User challenge for this collection WITHOUT the old `entryFee > 0`
  // filter, so free-entry User challenges are counted too (chargeEntryFees no-ops on entryFee<=0,
  // returning every image as paid — so behavior is unchanged for the caller, which still commits
  // when unpaidImageIds is empty). System/Mod (daily) + community-contest collections have no
  // source=User row → null → undefined (unchanged, no metric).
  const feeChallenge = await dbRead.challenge.findFirst({
    where: { collectionId, source: 'User', status: 'Active' },
    select: { id: true, entryFee: true, buzzType: true },
  });
  if (!feeChallenge) return undefined;
  const { chargeEntryFees } = await import('~/server/games/daily-challenge/challenge-funding');
  const buzzType = feeChallenge.buzzType === 'green' ? 'green' : 'yellow';
  const result = await chargeEntryFees({
    challengeId: feeChallenge.id,
    userId,
    imageIds,
    entryFee: feeChallenge.entryFee,
    fromAccountType: buzzType,
  });
  // Single chokepoint for the entry funnel: count each committable entry once (both fee paths —
  // the non-defer validate path and the deferred bulkSaveItems path — flow through here, so no
  // double count). paidImageIds are the images actually charged (paid) or all images (free).
  recordChallengeEntrySubmitted({
    source: 'User',
    buzzType,
    paid: feeChallenge.entryFee > 0,
    count: result.paidImageIds.length,
  });
  return result;
};

export const validateContestCollectionEntry = async ({
  collectionId,
  userId,
  isModerator,
  metadata,
  articleIds = [],
  modelIds = [],
  imageIds = [],
  postIds = [],
  // bulkSaveItems defers the entry-fee charge until AFTER the CollectionItem write (so a failed
  // save can't leave a paid-but-missing entry); every other caller charges here, before its write.
  deferEntryFeeCharge = false,
  // `userChallenges` for the submitting user. Defaults to denied: entries arrive through the
  // generic collection mutations, so a caller that forgets to thread the flag must fail closed.
  canAccessUserChallenges = false,
}: {
  collectionId: number;
  userId: number;
  isModerator?: boolean;
  metadata?: CollectionMetadataSchema;
  articleIds?: number[];
  modelIds?: number[];
  imageIds?: number[];
  postIds?: number[];
  deferEntryFeeCharge?: boolean;
  canAccessUserChallenges?: boolean;
}) => {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      meta: true,
    },
  });

  const userMeta = (user?.meta ?? {}) as UserMeta;

  if (userMeta?.contestBanDetails) {
    throw throwBadRequestError('You are banned from participating in contests');
  }

  // The source=User challenge (if any) that owns this collection. One lookup, reused by the flag
  // gate, the block gate, and the accepting-entries timing gate below — System/Mod (daily) and
  // community-contest collections have no such row, so this is null for them.
  const userChallenge = await dbRead.challenge.findFirst({
    where: { collectionId, source: ChallengeSource.User },
    select: { id: true, createdById: true, status: true },
  });

  // User-created challenges are still flag-gated, but entries reach this function through the
  // generic collection mutations, which carry no challenge-specific guard — so a direct link to
  // the challenge would otherwise be enough to submit. Scoped to source=User: ordinary contest
  // collections and System/Mod (daily) challenges are unaffected.
  if (!canAccessUserChallenges && userChallenge)
    throw throwAuthorizationError('This challenge is not currently available.');

  // Challenge creators may not enter their own challenge (self-dealing on the prize pool). Its own
  // lookup: it filters on createdById across ANY source, so it also catches a System/Mod challenge
  // the viewer created — which the source=User lookup above would miss.
  if (!isModerator) {
    const ownChallenge = await dbRead.challenge.findFirst({
      where: { collectionId, createdById: userId },
      select: { id: true },
    });
    if (ownChallenge) {
      throw throwBadRequestError('You cannot submit entries to your own challenge.');
    }
  }

  // A viewer the challenge creator has blocked can't submit an entry — parity with the detail-page
  // block gate. Scoped to source=User (System/mod challenges have no owner); moderators exempt.
  if (!isModerator && userChallenge) {
    const blocked = await amIBlockedByUser({
      userId,
      targetUserId: userChallenge.createdById ?? undefined,
    });
    if (blocked) throw throwBadRequestError('This challenge is not available.');
  }

  // Block re-submitting an image a challenge judge has already scored. Removal
  // hard-deletes the CollectionItem (erasing tag/score), so the judge's comment is the
  // durable "already judged" signal — across this and every other challenge. Limited to
  // challenge collections (target has a linked Challenge) so community contests are
  // unaffected. Scoped to genuine re-adds: an image still present as an entry is excluded,
  // so editing a post that re-saves its images doesn't fail.
  if (imageIds.length > 0 && !isModerator) {
    const alreadyJudged = await dbRead.$queryRaw<{ imageId: number }[]>`
      SELECT DISTINCT th."imageId"
      FROM "Thread" th
      JOIN "CommentV2" cm ON cm."threadId" = th.id
      JOIN "ChallengeJudge" cj ON cj."userId" = cm."userId"
      WHERE th."imageId" IN (${Prisma.join(imageIds)})
        AND EXISTS (SELECT 1 FROM "Challenge" ch WHERE ch."collectionId" = ${collectionId})
        AND NOT EXISTS (
          SELECT 1 FROM "CollectionItem" ci
          WHERE ci."collectionId" = ${collectionId}
            AND ci."imageId" = th."imageId"
            AND ci.status IN ('ACCEPTED', 'REVIEW')
        )
    `;
    if (alreadyJudged.length > 0) {
      throw throwBadRequestError(
        'This image has already been judged in a challenge and cannot be re-submitted. Please enter a new image.'
      );
    }
  }

  // User challenges accept entries only once Active — makes the entry WRITE agree with the fee
  // CHARGE (which already requires Active). No-op for daily/system/community collections.
  await assertUserChallengeAcceptingEntries(collectionId, userChallenge);

  if (!metadata) {
    return;
  }

  const savedItemsCount =
    (articleIds?.length ?? 0) +
    (modelIds?.length ?? 0) +
    (imageIds?.length ?? 0) +
    (postIds?.length ?? 0);

  if (metadata.maxItemsPerUser) {
    // check how many items user has created:
    const itemCount = await dbRead.collectionItem.count({
      where: {
        collectionId,
        addedById: userId,
        status: {
          in: [CollectionItemStatus.ACCEPTED, CollectionItemStatus.REVIEW],
        },
      },
    });

    if (itemCount + savedItemsCount > metadata.maxItemsPerUser && !isModerator) {
      throw throwBadRequestError(`You have reached the maximum number of items in collection`);
    }
  }

  if (
    (metadata.submissionStartDate && new Date(metadata.submissionStartDate) > new Date()) ||
    (metadata.submissionEndDate && new Date(metadata.submissionEndDate) < new Date())
  ) {
    throw throwBadRequestError('Collection is not accepting submissions at this time');
  }

  // You can only submit your own models to a contest. Enforced independently of the
  // submissionStartDate window below so it holds for windowless contests too.
  if (modelIds.length > 0 && !isModerator) {
    const submittedModels = await dbRead.model.findMany({
      where: { id: { in: modelIds } },
      select: { id: true, userId: true },
    });

    if (submittedModels.some((model) => model.userId !== userId)) {
      throw throwBadRequestError('You can only submit your own models to a contest.');
    }
  }

  const allowedBaseModels = metadata.baseModels?.filter(Boolean) ?? [];
  const submissionStartDate = metadata.submissionStartDate
    ? new Date(metadata.submissionStartDate)
    : undefined;

  if (modelIds.length > 0 && (allowedBaseModels.length > 0 || submissionStartDate)) {
    // Both contest rules must be met by ONE version, otherwise a stale SDXL model could qualify by
    // pairing an old allowed-base-model version with a throwaway version pushed during the window.
    // Keyed on the version's createdAt rather than publishedAt because publishedAt is reset by the
    // private-model round trip, which would let an untouched old model back in.
    const qualifyingVersion: Prisma.ModelVersionWhereInput = {
      status: { notIn: [ModelStatus.Deleted, ModelStatus.UnpublishedViolation] },
      ...(submissionStartDate ? { createdAt: { gte: submissionStartDate } } : {}),
      ...(allowedBaseModels.length > 0 ? { baseModel: { in: allowedBaseModels } } : {}),
    };

    const invalidModels = await dbRead.model.findMany({
      where: {
        id: { in: modelIds },
        // Without base-model gating the version requirement exists only to keep pre-window models
        // out, so a model created during the window passes on the model row alone.
        ...(allowedBaseModels.length === 0 && submissionStartDate
          ? { createdAt: { lt: submissionStartDate } }
          : {}),
        modelVersions: { none: qualifyingVersion },
      },
      select: { id: true },
    });

    if (invalidModels.length > 0) {
      if (allowedBaseModels.length > 0) {
        throw throwBadRequestError(
          submissionStartDate
            ? `Some models have no version added during the submission period on an allowed base model. This contest accepts: ${allowedBaseModels.join(
                ', '
              )}.`
            : `Some models have no version on an allowed base model. This contest accepts: ${allowedBaseModels.join(
                ', '
              )}.`
        );
      }

      throw throwBadRequestError(
        `Some models predate the submission start date and have no version added during the submission period. Add a new version to enter an existing model.`
      );
    }
  }

  if (metadata.submissionStartDate) {
    // confirm items were created after the start date
    if (articleIds.length > 0) {
      const articles = await dbRead.article.findMany({
        where: {
          id: { in: articleIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (articles.length > 0) {
        throw throwBadRequestError(
          `Some articles were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }

    if (imageIds.length > 0) {
      const images = await dbRead.image.findMany({
        where: {
          id: { in: imageIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (images.length > 0) {
        throw throwBadRequestError(
          `Some images were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }

    if (postIds.length > 0) {
      const posts = await dbRead.post.findMany({
        where: {
          id: { in: postIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (posts.length > 0) {
        throw throwBadRequestError(
          `Some posts were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }
  }

  // Check the entry is not on a featured collection:
  // Only validate if there are items to check
  if (modelIds.length > 0 || imageIds.length > 0 || articleIds.length > 0 || postIds.length > 0) {
    const featuredCollections = await dbRead.collection.findMany({
      where: {
        userId: -1, // Civit
        mode: null, // Not contest or anything like that
        name: { contains: 'Featured' },
      },
      select: { id: true },
    });

    if (featuredCollections.length > 0) {
      // Build WHERE clause for only the populated item type
      // This allows PostgreSQL to use the hash index on the specific item ID field first
      const whereClause: Prisma.CollectionItemWhereInput = {
        collectionId: { in: featuredCollections.map((f) => f.id) },
      };

      if (modelIds.length > 0) {
        whereClause.modelId = { in: modelIds };
      } else if (imageIds.length > 0) {
        whereClause.imageId = { in: imageIds };
      } else if (articleIds.length > 0) {
        whereClause.articleId = { in: articleIds };
      } else if (postIds.length > 0) {
        whereClause.postId = { in: postIds };
      }

      // Query uses item-specific index first (hash lookup), then filters by collectionId
      const existingCollectionItemsOnFeaturedCollections = await dbRead.collectionItem.findFirst({
        select: { id: true },
        where: whereClause,
      });

      if (existingCollectionItemsOnFeaturedCollections) {
        throw throwBadRequestError(
          'At least one of the items provided is already featured by civitai and cannot be added to the contest.'
        );
      }
    }
  }

  if (imageIds.length > 0 && metadata.forcedBrowsingLevel) {
    // Check if the images have the correct browsing level
    const allowedLevels = parseBitwiseBrowsingLevel(metadata.forcedBrowsingLevel);
    const images = await dbRead.image.findMany({
      select: { id: true, nsfwLevel: true },
      where: { id: { in: imageIds } },
    });

    // filter images that are above the forced browsing level
    const invalidImages = images.filter(
      (image) => image.nsfwLevel !== 0 && !allowedLevels.includes(image.nsfwLevel)
    );
    if (invalidImages.length > 0) {
      throw throwBadRequestError(
        `Some images have a higher rating than the allowed for the contest. Please ensure all images have a rating of ${allowedLevels
          .map((level) => NsfwLevel[level])
          .join(' or ')}.`
      );
    }
  }

  // Participant cap (user challenges): new participants are rejected once the cap is reached;
  // existing participants may keep adding entries up to maxEntriesPerUser. Checked before any
  // charge so a capped-out user is never charged.
  if (!isModerator) {
    const cappedChallenge = await dbRead.challenge.findFirst({
      where: { collectionId, status: 'Active', maxParticipants: { not: null } },
      select: { maxParticipants: true },
    });
    if (cappedChallenge?.maxParticipants) {
      const [counts] = await dbRead.$queryRaw<{ total: number; mine: number }[]>`
        SELECT
          COUNT(DISTINCT "addedById")::int AS total,
          (COUNT(DISTINCT "addedById") FILTER (WHERE "addedById" = ${userId}))::int AS mine
        FROM "CollectionItem"
        WHERE "collectionId" = ${collectionId}
      `;
      if (counts && counts.mine === 0 && counts.total >= cappedChallenge.maxParticipants) {
        throw throwBadRequestError(
          'This challenge has reached its maximum number of participants.'
        );
      }
    }
  }

  // Required resource: for challenges with configured modelVersionIds, every submitted image
  // must use at least one of them (OR logic — mirrors the promotion-time check in
  // challenge-rewards.ts:promoteChallengeEntries). Checked before the entry-fee charge below so
  // an off-resource image is never charged: previously this rule was enforced only at
  // promotion, after the fee already ran, and entry fees are never refunded (see
  // challenge-funding.ts) — so an off-resource submission was charged then silently rejected.
  if (imageIds.length > 0 && !isModerator) {
    const resourceChallenge = await dbRead.challenge.findFirst({
      where: { collectionId, status: 'Active', modelVersionIds: { isEmpty: false } },
      select: { modelVersionIds: true },
    });
    if (resourceChallenge) {
      // `detected: true` only — the resource has to have been read out of the image's own generation
      // metadata. A `detected: false` row is asserted by the uploader, by either route that writes
      // one: linking the post to the model version (unrestricted — about half of version-linked
      // posts point at someone else's model), or `addResourceToPostImage`, which credits a resource
      // by hand and refuses on-site generations. Counting those would make the requirement
      // self-certifiable on a challenge with a real prize pool.
      const withRequiredResource = await dbRead.imageResourceNew.findMany({
        where: {
          imageId: { in: imageIds },
          modelVersionId: { in: resourceChallenge.modelVersionIds },
          detected: true,
        },
        select: { imageId: true },
        distinct: ['imageId'],
      });
      const validImageIds = new Set(withRequiredResource.map((r) => r.imageId));
      if (imageIds.some((id) => !validImageIds.has(id))) {
        throw throwBadRequestError(
          "This image doesn't use a required model for this challenge. The model has to be readable from the image's own generation metadata — a resource credited by hand doesn't count. Generate on site, or re-upload the image with its metadata intact."
        );
      }
    }
  }

  // Entry fee: for user-created challenges, charge the participant once per submitted image
  // (idempotent per challenge+image). Runs only after all other validation has passed. Callers
  // that defer (bulkSaveItems) charge after their write instead, to avoid a paid-but-missing entry.
  if (!deferEntryFeeCharge) {
    const chargeResult = await chargeContestEntryFeesForCollection({
      collectionId,
      userId,
      imageIds,
    });
    if (chargeResult && chargeResult.unpaidImageIds.length > 0) {
      // Nothing was written yet, so aborting strands no entry. Any legs that DID charge stay
      // in the ledger (never refunded — see challenge-funding.ts) and complete idempotently
      // if the user retries with more Buzz.
      throw throwInsufficientFundsError(
        'You do not have enough Buzz to pay the entry fee for every submitted image.'
      );
    }
  }
};

const validateFeaturedCollectionEntry = async ({
  articleIds = [],
  modelIds = [],
  imageIds = [],
  postIds = [],
}: {
  articleIds?: number[];
  modelIds?: number[];
  imageIds?: number[];
  postIds?: number[];
}) => {
  // Check the entry is not on a contest collection
  // Only validate if there are items to check
  if (
    modelIds.length === 0 &&
    imageIds.length === 0 &&
    articleIds.length === 0 &&
    postIds.length === 0
  ) {
    return;
  }

  // Build the item filter clause based on which item type is provided
  let itemFilter: Prisma.Sql;
  if (modelIds.length > 0) {
    itemFilter = Prisma.sql`ci."modelId" IN (${Prisma.join(modelIds)})`;
  } else if (imageIds.length > 0) {
    itemFilter = Prisma.sql`ci."imageId" IN (${Prisma.join(imageIds)})`;
  } else if (articleIds.length > 0) {
    itemFilter = Prisma.sql`ci."articleId" IN (${Prisma.join(articleIds)})`;
  } else if (postIds.length > 0) {
    itemFilter = Prisma.sql`ci."postId" IN (${Prisma.join(postIds)})`;
  } else {
    return; // No items to check
  }

  // Use raw SQL to avoid Prisma's enum casting issue that prevents index usage
  // This query joins CollectionItem with Collection directly, using the Collection_contests
  // partial index for efficient Contest collection lookup
  const existingItems = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT ci.id
    FROM "CollectionItem" ci
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE c.mode = 'Contest'::"CollectionMode"
      AND ${itemFilter}
    LIMIT 1
  `;

  if (existingItems.length > 0) {
    throw throwBadRequestError(
      'At least one of the items provided is already in a contest collection and cannot be added to the featured collections.'
    );
  }
};

export const bulkSaveItems = async ({
  input: {
    userId,
    collectionId,
    articleIds = [],
    modelIds = [],
    imageIds = [],
    postIds = [],
    tagId,
    isModerator,
    canAccessUserChallenges,
  },
  permissions,
}: {
  input: BulkSaveCollectionItemsInput & {
    userId: number;
    isModerator?: boolean;
    canAccessUserChallenges?: boolean;
  };
  permissions: CollectionContributorPermissionFlags;
}) => {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: collectionWithoutImageSelect,
  });

  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);
  const inputTags = collection.tags?.filter((t) => !t.filterableOnly);

  if (
    inputTags.length > 0 &&
    !tagId &&
    !(collection.metadata as CollectionMetadataSchema)?.disableTagRequired
  ) {
    throw throwBadRequestError(
      'It is required to tag your entry in order for it to be added to this collection'
    );
  }

  if (collection.tags.length === 0 && tagId) {
    throw throwBadRequestError('This collection does not support tagging entries');
  }

  if (collection.tags.length > 0 && tagId && !collection.tags.find((t) => t.tag.id === tagId)) {
    throw throwBadRequestError('The tag provided is not allowed in this collection');
  }

  if (
    !permissions.isContributor &&
    !permissions.isOwner &&
    !(collection.metadata as CollectionMetadataSchema)?.disableFollowOnSubmission
  ) {
    // Make sure to follow the collection
    await addContributorToCollection({
      targetUserId: userId,
      userId: userId,
      collectionId,
    });
  }

  const metadata = (collection.metadata ?? {}) as CollectionMetadataSchema;

  if (collection.mode === CollectionMode.Contest) {
    await validateContestCollectionEntry({
      metadata,
      collectionId,
      userId,
      isModerator,
      canAccessUserChallenges,
      articleIds,
      modelIds,
      imageIds,
      postIds,
      // Charge the entry fee AFTER the write below (with rollback), not here.
      deferEntryFeeCharge: true,
    });
  }

  if (collection.userId == -1 && !collection.mode && collection.name.includes('Featured')) {
    // Assume it's a featured collection:
    await validateFeaturedCollectionEntry({
      articleIds,
      modelIds,
      imageIds,
      postIds,
    });
  }

  const status = submissionStatus(permissions);
  const baseData = {
    collectionId,
    addedById: userId,
    status,
    reviewedAt: status === CollectionItemStatus.ACCEPTED ? new Date() : null,
    reviewedById: status === CollectionItemStatus.ACCEPTED ? userId : null,
    tagId,
  };
  let data: Prisma.CollectionItemCreateManyInput[] = [];
  if (
    articleIds.length > 0 &&
    (collection.type === CollectionType.Article || collection.type === null)
  ) {
    const existingArticleIds = (
      await dbRead.collectionItem.findMany({
        select: {
          articleId: true,
          article: {
            select: {
              createdAt: true,
            },
          },
        },
        where: { articleId: { in: articleIds }, collectionId },
      })
    ).map((item) => item.articleId);

    data = articleIds
      .filter((id) => !existingArticleIds.includes(id))
      .map((articleId) => ({
        articleId,
        ...baseData,
      }));
  }

  if (
    modelIds.length > 0 &&
    (collection.type === CollectionType.Model || collection.type === null)
  ) {
    const existingModelIds = (
      await dbRead.collectionItem.findMany({
        select: { modelId: true },
        where: { modelId: { in: modelIds }, collectionId },
      })
    ).map((item) => item.modelId);

    data = modelIds
      .filter((id) => !existingModelIds.includes(id))
      .map((modelId) => ({
        modelId,
        ...baseData,
      }));
  }
  if (
    imageIds.length > 0 &&
    (collection.type === CollectionType.Image || collection.type === null)
  ) {
    const existingImageIds = (
      await dbRead.collectionItem.findMany({
        select: { imageId: true },
        where: { imageId: { in: imageIds }, collectionId },
      })
    ).map((item) => item.imageId);

    data = imageIds
      .filter((id) => !existingImageIds.includes(id))
      .map((imageId) => ({
        imageId,
        ...baseData,
      }));
  }
  if (postIds.length > 0 && (collection.type === CollectionType.Post || collection.type === null)) {
    const existingPostIds = (
      await dbRead.collectionItem.findMany({
        select: { postId: true },
        where: { postId: { in: postIds }, collectionId },
      })
    ).map((item) => item.postId);

    data = postIds
      .filter((id) => !existingPostIds.includes(id))
      .map((postId) => ({
        postId,
        ...baseData,
      }));
  }

  const { count } = await dbWrite.collectionItem.createMany({ data });
  const savedImageIds = data.map((d) => d.imageId).filter(isDefined);

  // Entry fee (user challenges): charge AFTER the entries are written so a failed save never
  // leaves a paid-but-missing entry. Charges are idempotent per (challenge, image) and NEVER
  // refunded (see challenge-funding.ts) — on a partial charge we keep the paid entries and
  // roll back only the unpaid rows; a Buzz charge can't be undone by a Postgres rollback.
  if (collection.mode === CollectionMode.Contest) {
    const chargeImageIds = savedImageIds;
    const rollbackItems = async (imageIds: number[], originalError: unknown) => {
      await dbWrite.collectionItem
        .deleteMany({
          where: { collectionId, addedById: userId, imageId: { in: imageIds } },
        })
        .catch((rollbackError) => {
          // Rollback failed → unpaid entries persist. Surface loudly; the caller still throws
          // the original error so the user sees the real failure.
          logToAxiom({
            type: 'error',
            name: 'contest-entry-fee-rollback-failed',
            message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            stack: rollbackError instanceof Error ? rollbackError.stack : undefined,
            originalError: originalError instanceof Error ? originalError.message : undefined,
            collectionId,
            userId,
            imageIds,
          });
        });
    };

    let chargeResult;
    try {
      chargeResult = await chargeContestEntryFeesForCollection({
        collectionId,
        userId,
        imageIds: chargeImageIds,
      });
    } catch (e) {
      // Transport/service failure — per-image payment state is unknown, so remove every row
      // this call wrote (leaving one would risk an unpaid committed entry). Any legs that DID
      // charge stay in the ledger and settle as idempotency conflicts on retry.
      if (chargeImageIds.length > 0) await rollbackItems(chargeImageIds, e);
      throw e;
    }

    if (chargeResult && chargeResult.unpaidImageIds.length > 0) {
      await rollbackItems(chargeResult.unpaidImageIds, new Error('insufficient funds'));
      // The paid entries above stay committed, so tag and bust the cache before aborting
      // the request. The unpaid ones were just deleted and must NOT be tagged — a rolled-back
      // submission that stayed tagged would be filtered out of feeds for an entry that never
      // landed, with nothing to undo it.
      if (chargeResult.paidImageIds.length > 0) {
        await applyCollectionAutoTag(metadata, chargeResult.paidImageIds);
        await homeBlockCacheBust(HomeBlockType.Collection, collectionId);
      }
      throw throwInsufficientFundsError(
        chargeResult.paidImageIds.length > 0
          ? `You ran out of Buzz partway through: ${chargeResult.paidImageIds.length} ${
              chargeResult.paidImageIds.length === 1 ? 'entry was' : 'entries were'
            } submitted, ${chargeResult.unpaidImageIds.length} could not be paid for.`
          : 'You do not have enough Buzz to pay the entry fee.'
      );
    }
  }

  // Tag AFTER the entry-fee block, so anything rolled back for non-payment is never tagged.
  await applyCollectionAutoTag(metadata, savedImageIds);

  // Bust AFTER the write so a concurrent read can't repopulate the cache with pre-write data.
  await homeBlockCacheBust(HomeBlockType.Collection, collectionId);

  // Check for challenge entry prize eligibility (Contest mode collections only)
  if (collection.mode === CollectionMode.Contest && count > 0) {
    // Import dynamically to avoid circular dependencies
    const { checkAndAwardEntryPrize } = await import(
      '~/server/games/daily-challenge/challenge-prize'
    );
    // Fire and forget - don't block the response
    checkAndAwardEntryPrize({ userId, collectionId }).catch(() => {
      // Silently ignore errors - prize distribution is not critical path
    });
  }

  // return imageIds for use in controller updateEntityMetrics
  return {
    count,
    imageIds: data.map((d) => d.imageId).filter(isDefined),
  };
};

type ImageProps = {
  type: MediaType;
  id: number;
  createdAt: Date;
  name: string | null;
  url: string;
  hash: string | null;
  height: number | null;
  width: number | null;
  nsfwLevel: NsfwLevel;
  postId: number | null;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  meta: Prisma.JsonObject | null;
  userId: number;
} | null;

type CollectionImageRaw = {
  id: number;
  image: ImageProps | null;
  src: string | null;
};

export const getCollectionCoverImages = async ({
  collectionIds,
  imagesPerCollection,
}: {
  collectionIds: number[];
  imagesPerCollection: number;
}) => {
  const imageSql = Prisma.sql`
    jsonb_build_object(
        'id', i."id",
        'index', i."index",
        'postId', i."postId",
        'name', i."name",
        'url', i."url",
        'nsfwLevel', i."nsfwLevel",
        'width', i."width",
        'height', i."height",
        'hash', i."hash",
        'createdAt', i."createdAt",
        'mimeType', i."mimeType",
        'scannedAt', i."scannedAt",
        'type', i."type",
        'meta', i."meta",
        'userId', i."userId"
      ) image
  `;

  const itemImages: CollectionImageRaw[] =
    collectionIds?.length > 0
      ? await dbRead.$queryRaw<CollectionImageRaw[]>`
    WITH target AS MATERIALIZED (
      SELECT *
      FROM (
        SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY ci."collectionId"
            ORDER BY ci.id
          ) AS idx
        FROM "CollectionItem" ci
        WHERE ci.status = 'ACCEPTED'
          AND ci."collectionId" IN (${Prisma.join(collectionIds)})
      ) t
      WHERE idx <= ${imagesPerCollection}
    ), imageItemImage AS MATERIALIZED (
      SELECT
        i.id,
        ${imageSql}
      FROM "Image" i
      WHERE i.id IN (SELECT "imageId" FROM target WHERE "imageId" IS NOT NULL)
        AND i."ingestion" = 'Scanned'
        AND i."needsReview" IS NULL
    ), postItemImage AS MATERIALIZED (
      SELECT * FROM (
          SELECT
            i."postId" id,
            ${imageSql},
            ROW_NUMBER() OVER (PARTITION BY i."postId" ORDER BY i.index) rn
          FROM "Image" i
          WHERE i."postId" IN (SELECT "postId" FROM target WHERE "postId" IS NOT NULL)
            AND i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
      ) t
      WHERE t.rn = 1
    ), modelItemImage AS MATERIALIZED (
      SELECT * FROM (
          SELECT
            m.id,
            ${imageSql},
            ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY mv.index, i."postId", i.index) rn
          FROM "Image" i
          JOIN "Post" p ON p.id = i."postId"
          JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
          JOIN "Model" m ON mv."modelId" = m.id AND m."userId" = p."userId"
          WHERE m."id" IN (SELECT "modelId" FROM target WHERE "modelId" IS NOT NULL)
              AND i."ingestion" = 'Scanned'
              AND i."needsReview" IS NULL
      ) t
      WHERE t.rn = 1
    ), articleItemImage as MATERIALIZED (
        SELECT a.id, a.cover image FROM "Article" a
        WHERE a.id IN (SELECT "articleId" FROM target)
    )
    SELECT
        target."collectionId" id,
        COALESCE(
          (SELECT image FROM imageItemImage iii WHERE iii.id = target."imageId"),
          (SELECT image FROM postItemImage pii WHERE pii.id = target."postId"),
          (SELECT image FROM modelItemImage mii WHERE mii.id = target."modelId"),
          NULL
        ) image,
        (SELECT image FROM articleItemImage aii WHERE aii.id = target."articleId") src
    FROM target
  `
      : [];

  // Use Redis cache for tag lookups (much faster than direct DB query)
  const imageIds = [...new Set(itemImages.map(({ image }) => image?.id).filter(isDefined))];
  const imageTagsCache = await tagIdsForImagesCache.fetch(imageIds);
  const tags = Object.entries(imageTagsCache).flatMap(([imageId, cache]) =>
    cache.tags.map((tagId) => ({ imageId: +imageId, tagId }))
  );

  return itemImages
    .map(({ id, image, src }) => ({
      id,
      image: image
        ? {
            ...image,
            tags: tags.filter((t) => t.imageId === image.id).map((t) => ({ id: t.tagId })),
          }
        : null,
      src,
    }))
    .filter((itemImage) => !!(itemImage.image || itemImage.src));
};

type CollectionForMeta = { id: number; metadata: CollectionMetadataSchema | null };

export const getContestsFromEntity = async ({
  entityType,
  entityId,
}: {
  entityType: 'post' | 'article' | 'model' | 'image';
  entityId: number;
}) => {
  const entityToField = {
    post: 'postId',
    article: 'articleId',
    model: 'modelId',
    image: 'imageId',
  };

  if (!entityToField[entityType]) {
    return [] as CollectionForMeta[];
  }

  const contestEntries = await dbRead.$queryRaw<CollectionForMeta[]>`
    SELECT ci."collectionId" as "id", c."metadata"
    FROM "CollectionItem" ci
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE ci."${Prisma.raw(entityToField[entityType])}" = ${entityId} AND c."mode" = 'Contest'
  `;

  return contestEntries;
};

export const removeCollectionItem = async ({
  userId,
  collectionId,
  itemId,
  isModerator,
}: RemoveCollectionItemInput & { userId: number; isModerator?: boolean }) => {
  const permissions = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });

  if (!permissions.collectionType) {
    throw throwNotFoundError('Unable to determine collection type');
  }

  let isOwner = false;
  const tableKey =
    permissions.collectionType === CollectionType.Model
      ? 'Model'
      : permissions.collectionType === CollectionType.Article
      ? 'Article'
      : permissions.collectionType === CollectionType.Image
      ? 'Image'
      : permissions.collectionType === CollectionType.Post
      ? 'Post'
      : null;

  if (!tableKey) throw throwNotFoundError('Unable to determine collection type');

  const [item] = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT "userId" FROM "${Prisma.raw(tableKey)}" WHERE id = ${itemId}
  `;
  if (!item) throw throwNotFoundError('Item not found');

  isOwner = item.userId === userId;

  const idColumn = Prisma.raw(`"${tableKey.toLowerCase()}Id"`);

  // Decided here rather than as a SQL predicate: both columns are nullable, and
  // `NOT (addedById = X AND note LIKE Y)` is NULL — not TRUE — whenever `note` is NULL, so the
  // statement silently matched nothing and still reported success.
  // Unbounded: prod has a partial unique index per entity type, but those indexes exist in no
  // migration, and the statement this replaced deleted every matching row regardless.
  const existing = await dbWrite.$queryRaw<
    { id: number; addedById: number | null; note: string | null }[]
  >`
    SELECT id, "addedById", note
    FROM "CollectionItem"
    WHERE "collectionId" = ${collectionId} AND ${idColumn} = ${itemId}
  `;

  // Every row, not some: removal below takes them all, so a submitter must not be able to drop
  // someone else's duplicate row alongside their own.
  const addedByCaller = existing.length > 0 && existing.every((row) => row.addedById === userId);

  // Deliberately does NOT accept `permissions.write` / `permissions.writeReview`: both are granted
  // to every authenticated user on a Public/Review-write collection regardless of ownership, so
  // honoring them here let anyone delete anyone else's item. A write grant authorizes adding.
  // `addedByCaller` is what the save modal's own Remove action offers ("you added this"), and
  // leaving it out here meant that button rendered for a Contributor and then 401'd.
  if (!isOwner && !addedByCaller && !permissions.manage && !isModerator) {
    throw throwAuthorizationError(
      'You do not have permission to remove items from this collection.'
    );
  }

  if (existing.length) {
    // An automatically featured item is rejected rather than deleted. Deleting it would let the
    // next job run re-add the same image, since the job's dedupe is "is there already a row" —
    // so for these rows the tombstone IS the removal. REJECTED is invisible to the render path,
    // which defaults to ACCEPTED only.
    const autoFeatureUserId = await getAutoFeatureUserId();
    const isAuto = (row: (typeof existing)[number]) => isAutoFeaturedRow(row, autoFeatureUserId);

    const tombstoneIds = existing.filter(isAuto).map((row) => row.id);
    const deletableIds = existing.filter((row) => !isAuto(row)).map((row) => row.id);

    if (tombstoneIds.length) {
      await dbWrite.collectionItem.updateMany({
        where: { id: { in: tombstoneIds } },
        data: {
          status: CollectionItemStatus.REJECTED,
          reviewedById: userId,
          reviewedAt: new Date(),
        },
      });
    }

    if (deletableIds.length) {
      await dbWrite.collectionItem.deleteMany({ where: { id: { in: deletableIds } } });
    }
  }

  return {
    collectionId,
    itemId,
    type: permissions.collectionType,
  };
};

export async function checkUserOwnsCollectionAndItem({
  itemId,
  collectionId,
  userId,
}: {
  itemId: number;
  collectionId: number;
  userId: number;
}) {
  const collection = await dbRead.collection.findFirst({
    where: { id: collectionId, userId },
    select: { type: true, userId: true },
  });
  if (!collection) return false;

  const tableKey =
    collection.type === CollectionType.Model
      ? 'Model'
      : collection.type === CollectionType.Article
      ? 'Article'
      : collection.type === CollectionType.Image
      ? 'Image'
      : collection.type === CollectionType.Post
      ? 'Post'
      : null;

  if (!tableKey) throw throwNotFoundError('Unable to determine collection type');

  const [item] = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT "userId" FROM "${Prisma.raw(tableKey)}" WHERE id = ${itemId}
  `;
  if (!item) return false;

  return item.userId === collection.userId;
}

export const setItemScore = async ({
  collectionItemId,
  userId,
  score,
}: SetItemScoreInput & { userId: number }) => {
  const collectionItem = await dbRead.collectionItem.findUnique({
    where: { id: collectionItemId },
    select: {
      id: true,
      collection: {
        select: { id: true, mode: true },
      },
    },
  });
  if (!collectionItem) throw throwNotFoundError('Collection item not found');
  if (!collectionItem.collection) throw throwNotFoundError('Collection not found');
  if (collectionItem.collection.mode !== CollectionMode.Contest)
    throw throwBadRequestError('This collection is not a contest collection');

  const itemScore = await dbWrite.collectionItemScore.upsert({
    where: { userId_collectionItemId: { userId, collectionItemId: collectionItem.id } },
    create: { userId, collectionItemId: collectionItem.id, score },
    update: { score },
  });

  return itemScore;
};

export const getCollectionItemById = ({ id }: GetByIdInput) => {
  const collectionItemFindArgs = {
    where: { id },
    include: {
      collection: true,
    },
  } as const;
  return dbRead.collectionItem.findUniqueOrThrow(collectionItemFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'collectionItem', caller: 'getCollectionItemById' });
    return dbWrite.collectionItem.findUniqueOrThrow(collectionItemFindArgs);
  });
};

export async function getCollectionEntryCount({
  collectionId,
  userId,
}: {
  collectionId: number;
  userId: number;
}) {
  const [collection] = await dbRead.$queryRaw<{ total: number }[]>`
    SELECT
      CAST(c.metadata->'maxItemsPerUser' as int) as total
    FROM "Collection" c
    WHERE c.id = ${collectionId}
  `;
  if (!collection) throw throwNotFoundError('Collection not found');

  const statuses = await dbRead.$queryRaw<{ status: CollectionItemStatus; count: number }[]>`
    SELECT
      "status",
      CAST(COUNT(*) as int) as "count"
    FROM "CollectionItem"
    WHERE "collectionId" = ${collectionId}
    AND "addedById" = ${userId}
    GROUP BY "status"
  `;

  const result: { [key in CollectionItemStatus]?: number } & { max: number } = {
    max: collection.total,
  };

  for (const { status, count } of statuses) result[status] = count;

  return result;
}

export const setCollectionItemNsfwLevel = async ({
  collectionItemId,
  nsfwLevel,
}: SetCollectionItemNsfwLevelInput) => {
  const collectionItem = await getCollectionItemById({ id: collectionItemId });

  if (!collectionItem) {
    throw throwNotFoundError('Collection item not found');
  }

  if (collectionItem.collection.type !== CollectionType.Image || !collectionItem.imageId) {
    throw throwBadRequestError(
      'NSFW Level assignment support is only available on image collections.'
    );
  }

  const metadata = (collectionItem.collection.metadata ?? {}) as CollectionMetadataSchema;

  if (!metadata?.judgesApplyBrowsingLevel) {
    throw throwBadRequestError('This collection does not support NSFW level assignment.');
  }

  const image = await dbRead.image.findUnique({
    where: { id: collectionItem.imageId as number },
    select: {
      post: {
        select: {
          collectionId: true,
        },
      },
    },
  });

  if (!image) {
    throw throwNotFoundError('Image not found');
  }

  if (image.post?.collectionId !== collectionItem.collectionId) {
    throw throwBadRequestError(
      'The image you are trying to apply an NSFW level to was not created for this collection. NSFW level assignment is only available for images created for this collection.'
    );
  }

  if (!nsfwLevel) throw throwBadRequestError();

  await dbWrite.image.update({
    where: { id: collectionItem.imageId as number },
    data: { nsfwLevel, scannedAt: new Date(), ingestion: ImageIngestionStatus.Scanned },
  });

  await imagesSearchIndex.queueUpdate([
    { id: collectionItem.imageId, action: SearchIndexUpdateQueueAction.Update },
  ]);
};

export type CollectionEntityType = 'image' | 'model' | 'post' | 'article';

/**
 * Removes an entity (image, model, post, or article) from all collections it's part of.
 * This is called when an entity is deleted or marked as ToS violation.
 *
 * @param entityType - The type of entity ('image', 'model', 'post', 'article')
 * @param entityId - The ID of the entity to remove from collections
 */
export async function removeEntityFromAllCollections(
  entityType: CollectionEntityType,
  entityId: number
) {
  // Build the where clause based on entity type
  const whereClause = {
    imageId: entityType === 'image' ? entityId : undefined,
    modelId: entityType === 'model' ? entityId : undefined,
    postId: entityType === 'post' ? entityId : undefined,
    articleId: entityType === 'article' ? entityId : undefined,
  };

  // Delete all collection items for this entity
  // If entity is not in any collections, this is a no-op (0 rows affected)
  await dbWrite.collectionItem.deleteMany({
    where: whereClause,
  });
}
