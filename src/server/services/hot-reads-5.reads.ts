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
import { activeAnnouncementWhere } from '~/server/services/announcement-window';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { resourceReviewSimpleSelect } from '~/server/selectors/resourceReview.selector';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { DomainColor, EntityType } from '~/shared/utils/prisma/enums';

/**
 * The reads behind `kysely-hot-reads-5`, each as a Prisma reader and its Kysely twin taking the
 * client, so the parity suite (__tests__/hot-reads-5.kysely-parity.test.ts) runs the very code the
 * services run. The Prisma readers are the original reads, moved here verbatim; each twin returns
 * the value its Prisma reader returns (same keys in the same order, Dates as Dates, enums as their
 * text, `null` where Prisma gives `null`).
 */

// ---------------------------------------------------------------------------------------------
// A `KeyValue` row by key (`getPlacementConfig`, placement.service.ts; the announcement allowance
// config, announcement-allowance.service.ts).

/** The Prisma read, unchanged. */
export function readKeyValueViaPrisma(db: PrismaClient, key: string) {
  return db.keyValue.findUnique({ where: { key } });
}

export async function readKeyValueViaKysely(
  db: Kysely<DB>,
  key: string
): Promise<Awaited<ReturnType<typeof readKeyValueViaPrisma>>> {
  const row = await getKeyValue(db, key);
  return row ? { key: row.key, value: row.value as Prisma.JsonValue } : null;
}

// ---------------------------------------------------------------------------------------------
// A post's linked Model3D (`getVisibleModel3DIdForPost`, model3d.service.ts).

/** The Prisma read, unchanged. */
export function readPostModel3dViaPrisma(db: PrismaClient, postId: number) {
  return db.post.findUnique({
    where: { id: postId },
    select: {
      model3d: { select: { id: true, userId: true, status: true, deletedAt: true } },
    },
  });
}

type PostModel3dRead = Awaited<ReturnType<typeof readPostModel3dViaPrisma>>;

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
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The ids of the live announcements a user dismissed (`getDismissedAnnouncementIds`,
// announcement.service.ts). "Live" is `activeAnnouncementWhere(now)` (announcement-window.ts); the
// Kysely conditions are its twin, and the parity suite pins the two on the same rows.

export type DismissedAnnouncementIdsInput = {
  userId: number;
  now: Date;
  domain?: DomainColor;
};

/** The Prisma read, unchanged (its `new Date()` is the caller's `now`). */
export async function readDismissedAnnouncementIdsViaPrisma(
  db: PrismaClient,
  { userId, now, domain }: DismissedAnnouncementIdsInput
) {
  const rows = await db.announcementDismissal.findMany({
    where: {
      userId,
      announcement: {
        ...activeAnnouncementWhere(now),
        ...(domain ? { domain: { hasSome: [DomainColor.all, domain] } } : {}),
      },
    },
    select: { announcementId: true },
  });

  return rows.map((x) => x.announcementId);
}

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

// ---------------------------------------------------------------------------------------------
// A post's owner and its collaborators (`getEntityCollaborators`, entity-collaborator.service.ts).

/** The Prisma reads, unchanged: the post's owner, then (for an existing post) its collaborators. */
export async function readPostCollaboratorsViaPrisma(db: PrismaClient, postId: number) {
  const entity = await db.post.findUnique({
    where: { id: postId },
    select: { userId: true },
  });
  if (!entity) return null;

  const collaborators = await db.entityCollaborator.findMany({
    where: { entityId: postId, entityType: EntityType.Post },
    select: {
      user: {
        select: userWithCosmeticsSelect,
      },
      entityId: true,
      entityType: true,
      status: true,
    },
  });
  return { entity, collaborators };
}

type PostCollaboratorsRead = NonNullable<
  Awaited<ReturnType<typeof readPostCollaboratorsViaPrisma>>
>;
type CollaboratorUser = PostCollaboratorsRead['collaborators'][number]['user'];

/**
 * The owner and the collaborator rows in ONE Kysely statement. A post with collaborators (rare)
 * then reads their users through Prisma with the same `userWithCosmeticsSelect`, so the nested
 * user (cosmetics, profile picture) is exactly the shape the Prisma read builds.
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

// ---------------------------------------------------------------------------------------------
// A home block row (`getHomeBlockById`, home-block.service.ts).

export const homeBlockByIdSelect = {
  id: true,
  metadata: true,
  type: true,
  userId: true,
  sourceId: true,
} as const;

/** The Prisma read, unchanged (it throws for a missing row, and for a missing `id`). */
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

// ---------------------------------------------------------------------------------------------
// The unclaimed prize count (`countUnclaimedPrizes`, prize.service.ts).

/** The Prisma read, unchanged. */
export function countUnclaimedPrizesViaPrisma(db: PrismaClient, userId: number) {
  return db.prize.count({ where: { userId, claimedAt: null, voidedAt: null } });
}

export function countUnclaimedPrizesViaKysely(db: Kysely<DB>, userId: number) {
  return countUnclaimedPrizes(db, userId);
}

// ---------------------------------------------------------------------------------------------
// A model's version ids (`getUserEngagedModelVersionsHandler`, user.controller.ts).

/** The Prisma read, unchanged. */
export function readModelVersionIdsViaPrisma(db: PrismaClient, modelId: number) {
  return db.modelVersion.findMany({
    where: { modelId },
    select: { id: true },
  });
}

export function readModelVersionIdsViaKysely(
  db: Kysely<DB>,
  modelId: number
): Promise<{ id: number }[]> {
  return listModelVersionIds(db, modelId);
}

// ---------------------------------------------------------------------------------------------
// A user's reviews of a model (`getUserResourceReview`, resourceReview.service.ts).

export type UserResourceReviewInput = {
  modelId?: number;
  modelVersionId?: number;
  userId: number;
};

/** The Prisma read, unchanged. */
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

// ---------------------------------------------------------------------------------------------
// The model version a download resolves (`getFileForModelVersion`, file.service.ts).

/** The Prisma read, unchanged. */
export function readModelVersionForFileViaPrisma(db: PrismaClient, modelVersionId: number) {
  return db.modelVersion.findFirst({
    // `model: { is: {} }` requires the (required) `model` relation to exist.
    // Without it, a ModelVersion whose `model` was hard-deleted (orphaned FK)
    // makes Prisma throw "Inconsistent query result: Field model is required to
    // return data, got null" at query execution → caught upstream → 500 on every
    // download lookup for that version. With the filter the DB drops the orphan
    // row, findFirst returns null, and we fall through to the `not-found` (404)
    // branch below — a model-less version is genuinely not downloadable. Same
    // class/fix as #2637 (relation-existence filter on orphaned required
    // relations).
    where: { id: modelVersionId, model: { is: {} } },
    select: {
      id: true,
      status: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
          publishedAt: true,
          status: true,
          userId: true,
          mode: true,
          nsfw: true,
          availability: true,
          poi: true,
        },
      },
      name: true,
      trainedWords: true,
      createdAt: true,
      requireAuth: true,
      usageControl: true,
    },
  });
}

type ModelVersionForFile = NonNullable<
  Awaited<ReturnType<typeof readModelVersionForFileViaPrisma>>
>;

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
  };
}

// ---------------------------------------------------------------------------------------------
// The three image reads of `reaction.toggle` (reaction.service.ts `getReaction`,
// reaction.controller.ts `getTrackerEvent` and the access check).

export type ImageReactionKey = { userId: number; reaction: ReviewReactions; imageId: number };

/** The Prisma read, unchanged. */
export function readImageReactionIdViaPrisma(
  db: PrismaClient,
  { userId, reaction, imageId }: ImageReactionKey
) {
  return db.imageReaction.findFirst({
    where: { userId, reaction, imageId },
    select: { id: true },
  });
}

export async function readImageReactionIdViaKysely(
  db: Kysely<DB>,
  key: ImageReactionKey
): Promise<{ id: number } | null> {
  return (await getImageReactionId(db, key)) ?? null;
}

/** The Prisma read, unchanged. */
export function readImageNsfwLevelAndOwnerViaPrisma(db: PrismaClient, id: number) {
  return db.image.findFirst({
    where: {
      id,
    },
    select: {
      nsfwLevel: true,
      userId: true,
    },
  });
}

export async function readImageNsfwLevelAndOwnerViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<{ nsfwLevel: number; userId: number } | null> {
  return (await getImageNsfwLevelAndOwner(db, id)) ?? null;
}

/**
 * The Prisma read, unchanged: the whole image row, of which the caller keeps `postId`. It throws for
 * a missing image.
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

// ---------------------------------------------------------------------------------------------
// A model's `meta` (`getModelCollectionShowcaseHandler`, model.controller.ts, through `getModel`).

/** The Prisma read `getModel({ id, select: { id: true, meta: true } })` makes (`findModel`). */
export function readModelMetaViaPrisma(db: PrismaClient, id: number) {
  return db.model.findFirst({ where: { id }, select: { id: true, meta: true } });
}

export async function readModelMetaViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<Awaited<ReturnType<typeof readModelMetaViaPrisma>>> {
  const row = await getModelMeta(db, id);
  return row ? { id: row.id, meta: row.meta as Prisma.JsonValue } : null;
}
