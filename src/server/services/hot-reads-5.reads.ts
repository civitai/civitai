import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  countUnclaimedPrizes,
  getHomeBlockRow,
  getImageNsfwLevelAndOwner,
  getImagePostId,
  getImageReactionId,
  getKeyValue,
  getModelMeta,
  getModelVersionForFile,
  getPostModel3d,
  listDismissedAnnouncementIds,
  listModelVersionIds,
  listPostCollaborators,
  listUserResourceReviews,
} from '@civitai/db-queries/hot-reads-5';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { resourceReviewSimpleSelect } from '~/server/selectors/resourceReview.selector';
import type {
  EntityCollaboratorStatus,
  EntityType,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { DomainColor } from '~/shared/utils/prisma/enums';

/**
 * Kysely reads, each returning the value the Prisma read it replaced returned (same keys in the same
 * order, Dates as Dates, enums as their text, `null` where Prisma gave `null`). Each takes the
 * client, so __tests__/hot-reads-5.kysely-parity.test.ts runs the very code the services run. The
 * three Prisma readers left here still serve a path: the home block with no `id`, a review read
 * inside a transaction, and the image a `reaction.toggle` access check cannot find.
 */

// A `KeyValue` row by key (`getPlacementConfig`, placement.service.ts; the announcement allowance
// config, announcement-allowance.service.ts).

export async function readKeyValueViaKysely(
  db: Kysely<DB>,
  key: string
): Promise<{ key: string; value: Prisma.JsonValue } | null> {
  const row = await getKeyValue(db, key);
  return row ? { key: row.key, value: row.value as Prisma.JsonValue } : null;
}

// A post's linked Model3D (`getVisibleModel3DIdForPost`, model3d.service.ts).

/** The Prisma `post.findUnique` shape: `null` for a missing post, `model3d: null` for no Model3D. */
type PostModel3dRead = Prisma.PostGetPayload<{
  select: {
    model3d: {
      select: { id: true; userId: true; status: true; deletedAt: true; tosViolation: true };
    };
  };
}> | null;

export async function readPostModel3dViaKysely(
  db: Kysely<DB>,
  postId: number
): Promise<PostModel3dRead> {
  const row = await getPostModel3d(db, postId);
  if (!row) return null;
  if (row.model3dRowId === null) return { model3d: null };
  return {
    model3d: {
      id: row.model3dRowId,
      userId: row.model3dUserId as number,
      status: row.model3dStatus as NonNullable<NonNullable<PostModel3dRead>['model3d']>['status'],
      deletedAt: row.model3dDeletedAt,
      tosViolation: row.model3dTosViolation as boolean,
    },
  };
}

// The ids of the live announcements a user dismissed (`getDismissedAnnouncementIds`,
// announcement.service.ts). "Live" is `activeAnnouncementWhere(now)` (announcement-window.ts); the
// Kysely conditions are its twin, and the parity suite pins them to what the Prisma read returned.

export type DismissedAnnouncementIdsInput = {
  userId: number;
  now: Date;
  domain?: DomainColor;
};

export async function readDismissedAnnouncementIdsViaKysely(
  db: Kysely<DB>,
  { userId, now, domain }: DismissedAnnouncementIdsInput
): Promise<number[]> {
  const rows = await listDismissedAnnouncementIds(db, {
    userId,
    now,
    domains: domain ? [DomainColor.all, domain] : undefined,
  });
  return rows.map((x) => x.announcementId);
}

// A post's owner and its collaborators (`getEntityCollaborators`, entity-collaborator.service.ts).

type CollaboratorUser = Prisma.UserGetPayload<{ select: typeof userWithCosmeticsSelect }>;
/** The post's owner and its collaborators, in the shape the Prisma reads built. */
type PostCollaboratorsRead = {
  entity: { userId: number };
  collaborators: {
    user: CollaboratorUser;
    entityId: number;
    entityType: EntityType;
    status: EntityCollaboratorStatus;
  }[];
};

/**
 * The owner and the collaborator rows in ONE Kysely statement. A post with collaborators (rare)
 * then reads their users through Prisma with the same `userWithCosmeticsSelect`, so the nested
 * user (cosmetics, profile picture) is exactly the shape the Prisma read built.
 */
export async function readPostCollaboratorsViaKysely(
  db: Kysely<DB>,
  usersDb: PrismaClient,
  postId: number
): Promise<PostCollaboratorsRead | null> {
  const rows = await listPostCollaborators(db, postId);
  if (!rows.length) return null;
  const entity = { userId: rows[0].postUserId };
  const collaboratorRows = rows.filter((row) => row.collaboratorUserId !== null);
  if (!collaboratorRows.length) return { entity, collaborators: [] };

  const users = await usersDb.user.findMany({
    where: { id: { in: collaboratorRows.map((row) => row.collaboratorUserId as number) } },
    select: userWithCosmeticsSelect,
  });
  const usersById = new Map<number, CollaboratorUser>(users.map((user) => [user.id, user]));
  const collaborators: PostCollaboratorsRead['collaborators'] = [];
  for (const row of collaboratorRows) {
    // `EntityCollaborator.userId` is a required foreign key, so every user is found.
    const user = usersById.get(row.collaboratorUserId as number);
    if (!user) continue;
    collaborators.push({
      user,
      entityId: row.entityId as number,
      entityType: row.entityType as PostCollaboratorsRead['collaborators'][number]['entityType'],
      status: row.status as PostCollaboratorsRead['collaborators'][number]['status'],
    });
  }
  return { entity, collaborators };
}

// A home block row (`getHomeBlockById`, home-block.service.ts).

export const homeBlockByIdSelect = {
  id: true,
  metadata: true,
  type: true,
  userId: true,
  sourceId: true,
} as const;

/** Throws for a missing row, and for a missing `id`. */
export function readHomeBlockViaPrisma(db: PrismaClient, id: number | undefined) {
  return db.homeBlock.findUniqueOrThrow({ select: homeBlockByIdSelect, where: { id } });
}

type HomeBlockRead = Awaited<ReturnType<typeof readHomeBlockViaPrisma>>;

/** The row, or `null` for a missing row: the caller then falls back exactly as Prisma's throw did. */
export async function readHomeBlockViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<HomeBlockRead | null> {
  const row = await getHomeBlockRow(db, id);
  if (!row) return null;
  return {
    id: row.id,
    metadata: row.metadata as Prisma.JsonValue,
    type: row.type as HomeBlockRead['type'],
    userId: row.userId,
    sourceId: row.sourceId,
  };
}

// The unclaimed prize count (`countUnclaimedPrizes`, prize.service.ts).

export function countUnclaimedPrizesViaKysely(db: Kysely<DB>, userId: number) {
  return countUnclaimedPrizes(db, userId);
}

// A model's version ids (`getUserEngagedModelVersionsHandler`, user.controller.ts).

export function readModelVersionIdsViaKysely(
  db: Kysely<DB>,
  modelId: number
): Promise<{ id: number }[]> {
  return listModelVersionIds(db, modelId);
}

// A user's reviews of a model (`getUserResourceReview`, resourceReview.service.ts).

export type UserResourceReviewInput = {
  modelId?: number;
  modelVersionId?: number;
  userId: number;
};

/** The Prisma read, for a caller inside a transaction. */
export function readUserResourceReviewsViaPrisma(
  db: PrismaClient | Prisma.TransactionClient,
  { modelId, modelVersionId, userId }: UserResourceReviewInput
) {
  return db.resourceReview.findMany({
    where: { modelId, modelVersionId, userId },
    select: resourceReviewSimpleSelect,
  });
}

export function readUserResourceReviewsViaKysely(
  db: Kysely<DB>,
  input: UserResourceReviewInput
): Promise<Awaited<ReturnType<typeof readUserResourceReviewsViaPrisma>>> {
  return listUserResourceReviews(db, input);
}

// The model version a download resolves (`getFileForModelVersion`, file.service.ts).

/**
 * The version and its model, in the shape the Prisma `modelVersion.findFirst` returned. A version
 * whose model row was hard-deleted (an orphaned foreign key) is `null`: the inner join drops it,
 * where Prisma needed a `model: { is: {} }` filter to avoid throwing on the missing relation.
 */
type ModelVersionForFile = Prisma.ModelVersionGetPayload<{
  select: {
    id: true;
    status: true;
    model: {
      select: {
        id: true;
        name: true;
        type: true;
        publishedAt: true;
        status: true;
        userId: true;
        mode: true;
        nsfw: true;
        availability: true;
        poi: true;
      };
    };
    name: true;
    trainedWords: true;
    createdAt: true;
    requireAuth: true;
    usageControl: true;
    baseModel: true;
  };
}>;

export async function readModelVersionForFileViaKysely(
  db: Kysely<DB>,
  modelVersionId: number
): Promise<ModelVersionForFile | null> {
  const row = await getModelVersionForFile(db, modelVersionId);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as ModelVersionForFile['status'],
    model: {
      id: row.modelId,
      name: row.modelName,
      type: row.modelType as ModelVersionForFile['model']['type'],
      publishedAt: row.modelPublishedAt,
      status: row.modelStatus as ModelVersionForFile['model']['status'],
      userId: row.modelUserId,
      mode: row.modelMode as ModelVersionForFile['model']['mode'],
      nsfw: row.modelNsfw,
      availability: row.modelAvailability as ModelVersionForFile['model']['availability'],
      poi: row.modelPoi,
    },
    name: row.name,
    // A NULL list column reads as `[]` through Prisma (the parity suite pins a NULL row).
    trainedWords: row.trainedWords ?? [],
    createdAt: row.createdAt,
    requireAuth: row.requireAuth,
    usageControl: row.usageControl as ModelVersionForFile['usageControl'],
    baseModel: row.baseModel,
  };
}

// The three image reads of `reaction.toggle` (reaction.service.ts `getReaction`,
// reaction.controller.ts `getTrackerEvent` and the access check).

export type ImageReactionKey = { userId: number; reaction: ReviewReactions; imageId: number };

export async function readImageReactionIdViaKysely(
  db: Kysely<DB>,
  key: ImageReactionKey
): Promise<{ id: number } | null> {
  return (await getImageReactionId(db, key)) ?? null;
}

export async function readImageNsfwLevelAndOwnerViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<{ nsfwLevel: number; userId: number } | null> {
  return (await getImageNsfwLevelAndOwner(db, id)) ?? null;
}

/**
 * The whole image row, of which the caller keeps `postId`. Throws for a missing image.
 */
export function readImagePostIdViaPrisma(db: PrismaClient, id: number) {
  return db.image.findUniqueOrThrow({ where: { id } }).then((image) => image?.postId);
}

/**
 * The `postId` alone. A missing image resolves to `undefined` here; the caller then runs the Prisma
 * read, so the error it throws is unchanged.
 */
export async function readImagePostIdViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<{ postId: number | null } | undefined> {
  return getImagePostId(db, id);
}

// A model's `meta` (`getModelCollectionShowcaseHandler`, model.controller.ts, through `getModel`).

/** What `getModel({ id, select: { id: true, meta: true } })` returned, or `null`. */
export async function readModelMetaViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<{ id: number; meta: Prisma.JsonValue } | null> {
  const row = await getModelMeta(db, id);
  return row ? { id: row.id, meta: row.meta as Prisma.JsonValue } : null;
}
