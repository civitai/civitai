import { Prisma, type PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getModelPoiAndOwner,
  getModelVersionOwnerWithCosmetics,
  getModelVersionPrivacyRow,
  getPostDetailRow,
  getUserIdByUsername,
  getUserWithCosmetics,
  listActiveModelVersionDonationGoals,
  listDonationGoalTotals,
  listDownloadFiles,
  listExistingModelVersionIds,
  listModelAssociationTargets,
  listModelVersionEngagements,
  listUserBannedAtByUsername,
  listUserRecommendedReviews,
  type DownloadFilesWhere,
  type PostDetailViewer,
  type UserWithCosmeticsRow,
} from '@civitai/db-queries/hot-reads-6';
import { postSelect } from '~/server/selectors/post.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getPostDetailVisibility } from '~/server/services/post-detail-visibility';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';

/**
 * The reads behind `kysely-hot-reads-6`, each as a Prisma reader and its Kysely twin taking the
 * client, so the parity suite (__tests__/hot-reads-6.kysely-parity.test.ts) runs the very code the
 * services run. The Prisma readers are the original reads, moved here verbatim; each twin returns
 * the value its Prisma reader returns (same keys in the same order, Dates as Dates, enums as their
 * text, `null` where Prisma gives `null`).
 */

type UserWithCosmetics = Prisma.UserGetPayload<{ select: typeof userWithCosmeticsSelect }>;
type ProfilePicture = NonNullable<UserWithCosmetics['profilePicture']>;
type UserCosmetic = UserWithCosmetics['cosmetics'][number]['cosmetic'];

/** A `userWithCosmeticsSelect` payload from its Kysely row. */
function toUserWithCosmetics(row: UserWithCosmeticsRow): UserWithCosmetics {
  return {
    id: row.id,
    username: row.username,
    deletedAt: row.deletedAt,
    image: row.image,
    profilePicture:
      row.profilePictureId !== null
        ? {
            id: row.profilePictureId,
            name: row.profilePictureName,
            url: row.profilePictureUrl as string,
            nsfwLevel: row.profilePictureNsfwLevel as number,
            hash: row.profilePictureHash,
            userId: row.profilePictureUserId as number,
            ingestion: row.profilePictureIngestion as ProfilePicture['ingestion'],
            type: row.profilePictureType as ProfilePicture['type'],
            width: row.profilePictureWidth,
            height: row.profilePictureHeight,
            metadata: row.profilePictureMetadata as Prisma.JsonValue,
          }
        : null,
    cosmetics: row.cosmetics.map((cosmetic) => ({
      data: cosmetic.data as Prisma.JsonValue,
      cosmetic: {
        id: cosmetic.cosmeticId,
        data: cosmetic.cosmeticData as Prisma.JsonValue,
        type: cosmetic.cosmeticType as UserCosmetic['type'],
        source: cosmetic.cosmeticSource as UserCosmetic['source'],
        name: cosmetic.cosmeticName,
      },
    })),
  };
}

// The owner of a model version's model (`getModelVersionOwnerHandler`, model-version.controller.ts).

/** `getVersionById({ id, select })` with that handler's select, on the client it is given. */
export function readModelVersionOwnerViaPrisma(db: PrismaClient, id: number) {
  return db.modelVersion.findUnique({
    where: { id },
    select: { model: { select: { user: { select: userWithCosmeticsSelect } } } },
  });
}

/**
 * The owner in one statement. No row (a missing version, or an orphaned model or user) returns
 * `undefined`: the caller then runs the Prisma read, so a missing version is still `null` and an
 * orphan still throws as Prisma throws.
 */
export async function readModelVersionOwnerViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<Awaited<ReturnType<typeof readModelVersionOwnerViaPrisma>> | undefined> {
  const row = await getModelVersionOwnerWithCosmetics(db, id);
  if (!row) return undefined;
  return { model: { user: { ...toUserWithCosmetics(row), image: null } } };
}

// A post's detail row (`getPostDetail`, post.service.ts).

/** The Prisma read; its `new Date()` (inside `getPostDetailVisibility`) is the caller's clock. */
export function readPostDetailViaPrisma(
  db: PrismaClient,
  { id, viewer }: { id: number; viewer: PostDetailViewer }
) {
  return db.post.findFirst({
    where: { id, ...getPostDetailVisibility(viewer) },
    select: postSelect,
  });
}

type PostDetailRead = NonNullable<Awaited<ReturnType<typeof readPostDetailViaPrisma>>>;

/**
 * The post and its tags in one statement, then its user with cosmetics in a second. A post whose
 * user row is gone returns `undefined`: the caller then runs the Prisma read, which throws for it.
 */
export async function readPostDetailViaKysely(
  db: Kysely<DB>,
  { id, viewer, now }: { id: number; viewer: PostDetailViewer; now: Date }
): Promise<PostDetailRead | null | undefined> {
  const row = await getPostDetailRow(db, { id, viewer, now });
  if (!row) return null;
  const user = await getUserWithCosmetics(db, row.userId);
  if (!user) return undefined;
  return {
    id: row.id,
    nsfw: row.nsfw,
    nsfwLevel: row.nsfwLevel,
    title: row.title,
    detail: row.detail,
    modelVersionId: row.modelVersionId,
    modelVersion: row.publishedModelVersionId !== null ? { id: row.publishedModelVersionId } : null,
    user: toUserWithCosmetics(user),
    publishedAt: row.publishedAt,
    availability: row.availability as PostDetailRead['availability'],
    tags: row.tags.map((tag) => ({
      tag: { id: tag.id, name: tag.name, isCategory: tag.isCategory },
    })),
    collectionId: row.collectionId,
  };
}

// The POI/owner check of the `model.*` visibility middleware (`modelVisibleToViewer`,
// model.router.ts).

export function readModelPoiAndOwnerViaPrisma(db: PrismaClient, id: number) {
  return db.model.findUnique({ where: { id }, select: { poi: true, userId: true } });
}

export async function readModelPoiAndOwnerViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<{ poi: boolean; userId: number } | null> {
  const row = await getModelPoiAndOwner(db, id);
  return row ? { ...row, poi: false } : null;
}

// A user's id by username (`findUserIdByUsername`, image.service.ts, the replica read).

export function readUserIdByUsernameViaPrisma(db: PrismaClient, username: string) {
  return db.user.findUnique({ where: { username }, select: { id: true } });
}

export async function readUserIdByUsernameViaKysely(
  db: Kysely<DB>,
  username: string
): Promise<{ id: number } | null> {
  return (await getUserIdByUsername(db, username)) ?? { id: -1 };
}

// A user's `bannedAt` by username (the `/user/[username]/*` tab pages' banned redirect).

export function readUserBannedAtViaPrisma(db: PrismaClient, username: string) {
  return db.user.findUnique({ where: { username }, select: { bannedAt: true } });
}

export async function readUserBannedAtViaKysely(
  db: Kysely<DB>,
  username: string
): Promise<{ bannedAt: Date | null } | null> {
  const row = await listUserBannedAtByUsername(db, username);
  return row ? { bannedAt: null } : null;
}

// The public donation goals cache's lookup (`publicDonationGoalsLookupFn`,
// donation-goals-cache.ts), its replica reads.

export function readExistingModelVersionIdsViaPrisma(db: PrismaClient, ids: number[]) {
  return db.modelVersion.findMany({ where: { id: { in: ids } }, select: { id: true } });
}

export function readExistingModelVersionIdsViaKysely(
  db: Kysely<DB>,
  ids: number[]
): Promise<{ id: number }[]> {
  return listExistingModelVersionIds(db, ids);
}

export function readActiveDonationGoalsViaPrisma(db: PrismaClient, versionIds: number[]) {
  return db.donationGoal.findMany({
    where: {
      entityType: 'ModelVersion',
      entityId: { in: versionIds },
      active: true,
    },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      userId: true,
      createdAt: true,
      description: true,
      entityId: true,
    },
  });
}

export function readActiveDonationGoalsViaKysely(
  db: Kysely<DB>,
  versionIds: number[]
): Promise<Awaited<ReturnType<typeof readActiveDonationGoalsViaPrisma>>> {
  return listActiveModelVersionDonationGoals(db, versionIds);
}

/** The raw totals query, unchanged (it is called with a non-empty list). */
export function readDonationGoalTotalsViaPrisma(db: PrismaClient, goalIds: number[]) {
  return db.$queryRaw<{ donationGoalId: number; total: number }[]>`
      SELECT
        "donationGoalId",
        SUM("amount")::int as total
      FROM "Donation"
      WHERE "donationGoalId" IN (${Prisma.join(goalIds)})
      GROUP BY "donationGoalId"
    `;
}

export function readDonationGoalTotalsViaKysely(
  db: Kysely<DB>,
  goalIds: number[]
): Promise<{ donationGoalId: number; total: number }[]> {
  return listDonationGoalTotals(db, goalIds);
}

// A user's engagements with model versions (`getUserEngagedModelVersions`, user.service.ts).

export type ModelVersionEngagementsInput = { userId: number; modelVersionIds: number[] };

export function readModelVersionEngagementsViaPrisma(
  db: PrismaClient,
  { userId, modelVersionIds }: ModelVersionEngagementsInput
) {
  return db.modelVersionEngagement.findMany({
    where: { userId, modelVersionId: { in: modelVersionIds } },
    select: { modelVersionId: true, type: true },
  });
}

export function readModelVersionEngagementsViaKysely(
  db: Kysely<DB>,
  input: ModelVersionEngagementsInput
): Promise<Awaited<ReturnType<typeof readModelVersionEngagementsViaPrisma>>> {
  return listModelVersionEngagements(db, input) as Promise<
    Awaited<ReturnType<typeof readModelVersionEngagementsViaPrisma>>
  >;
}

// A model's associated resources (`getAssociatedResourcesCardDataHandler`, model.controller.ts).

export type ModelAssociationsInput = { fromModelId: number; type?: AssociationType };

export function readModelAssociationTargetsViaPrisma(
  db: PrismaClient,
  { fromModelId, type }: ModelAssociationsInput
) {
  return db.modelAssociations.findMany({
    where: { fromModelId, type },
    select: { toModelId: true, toArticleId: true },
    orderBy: { index: 'asc' },
  });
}

export function readModelAssociationTargetsViaKysely(
  db: Kysely<DB>,
  input: ModelAssociationsInput
): Promise<{ toModelId: number | null; toArticleId: number | null }[]> {
  return listModelAssociationTargets(db, input);
}

// A user's recommended reviews (`getResourceReviewsByUserId`, resourceReview.service.ts).

export type UserReviewsInput = { userId: number; recommended?: boolean; modelIds?: number[] };

export function readUserReviewsViaPrisma(
  db: PrismaClient,
  { userId, recommended, modelIds }: UserReviewsInput
) {
  return db.resourceReview.findMany({
    where: { userId, recommended, ...(modelIds ? { modelId: { in: modelIds } } : {}) },
    select: { modelId: true, modelVersionId: true },
  });
}

export function readUserReviewsViaKysely(
  db: Kysely<DB>,
  input: UserReviewsInput
): Promise<{ modelId: number; modelVersionId: number }[]> {
  return listUserRecommendedReviews(db, input);
}

// A model version's metric-privacy inputs (`prepareModelVersionResponse`,
// pages/api/v1/model-versions/[id].ts).

export function readModelVersionPrivacyViaPrisma(db: PrismaClient, id: number) {
  return db.modelVersion.findUnique({
    where: { id },
    select: {
      meta: true,
      model: { select: { meta: true, userId: true, user: { select: { settings: true } } } },
    },
  });
}

type ModelVersionPrivacyRead = Awaited<ReturnType<typeof readModelVersionPrivacyViaPrisma>>;

/**
 * The inputs in one statement. A version whose model or user row is gone returns `undefined`: the
 * caller then runs the Prisma read, which throws for it.
 */
export async function readModelVersionPrivacyViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<ModelVersionPrivacyRead | undefined> {
  const row = await getModelVersionPrivacyRow(db, id);
  if (!row) return null;
  if (row.modelRowId === null || row.userRowId === null) return undefined;
  return {
    meta: row.meta as Prisma.JsonValue,
    model: {
      meta: row.modelMeta as Prisma.JsonValue,
      userId: row.modelUserId as number,
      user: { settings: {} as Prisma.JsonValue },
    },
  };
}

// A version's downloadable files (`getFileForModelVersion`, file.service.ts).

export const downloadFileSelect = {
  id: true,
  url: true,
  name: true,
  overrideName: true,
  type: true,
  metadata: true,
  sizeKB: true,
  hashes: { select: { hash: true }, where: { type: 'SHA256' as const } },
};

export function readDownloadFilesViaPrisma(db: PrismaClient, where: Prisma.ModelFileWhereInput) {
  return db.modelFile.findMany({ where, select: downloadFileSelect });
}

/** The Prisma `where` the download path builds, from the same inputs. */
export function downloadFilesWhere({
  modelVersionId,
  notReplaced,
  type,
  publicOnly,
}: DownloadFilesWhere): Prisma.ModelFileWhereInput {
  const where: Prisma.ModelFileWhereInput = { modelVersionId };
  if (notReplaced) where.replacedAt = null;
  if (type) where.type = type;
  if (publicOnly) where.visibility = ModelFileVisibility.Public;
  return where;
}

export async function readDownloadFilesViaKysely(
  db: Kysely<DB>,
  where: DownloadFilesWhere
): Promise<Awaited<ReturnType<typeof readDownloadFilesViaPrisma>>> {
  const rows = await listDownloadFiles(db, { ...where, type: where.type || undefined });
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    name: row.name,
    overrideName: row.overrideName,
    type: row.type,
    metadata: row.metadata as Prisma.JsonValue,
    sizeKB: row.sizeKB,
    hashes: row.hashes.map((hash) => ({ hash: hash.hash })),
  }));
}
