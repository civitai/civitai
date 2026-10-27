import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  countSuggestedResources,
  getUserSettings,
  listDefaultModelVersionRows,
  listModelPagePosts,
  listViewerPendingRemixPlacements,
} from '@civitai/db-queries/hot-reads-3';

/**
 * The reads behind `kysely-hot-reads-3`, each as a Prisma reader and its Kysely twin taking the
 * client, so the parity suite (__tests__/hot-reads-3.kysely-parity.test.ts) runs the very code the
 * services run. The Prisma readers are the original reads, moved here verbatim.
 */

// ---------------------------------------------------------------------------------------------
// The model page's default-version lookup (`getDefaultModelVersion`, model-version.service.ts).

export type DefaultModelVersionInput = { modelId: number; modelVersionId?: number };

const defaultModelVersionSelect = (modelVersionId?: number) =>
  ({
    modelVersions: {
      take: 10,
      where: modelVersionId ? { id: modelVersionId } : undefined,
      orderBy: { index: 'asc' },
      select: {
        id: true,
        status: true,
        publishedAt: true,
        model: { select: { id: true, userId: true, availability: true, status: true } },
        availability: true,
        trainingStatus: true,
      },
    },
  } satisfies Prisma.ModelSelect);

export type DefaultModelVersionRead = Prisma.ModelGetPayload<{
  select: ReturnType<typeof defaultModelVersionSelect>;
}> | null;

/** The Prisma read, unchanged: the model, its versions, and each version's model. */
export function readDefaultModelVersionsViaPrisma(
  db: PrismaClient,
  { modelId, modelVersionId }: DefaultModelVersionInput
): Promise<DefaultModelVersionRead> {
  return db.model.findUnique({
    where: { id: modelId },
    select: defaultModelVersionSelect(modelVersionId),
  });
}

/**
 * The same answer from ONE statement (`listDefaultModelVersionRows`): no rows is a missing model
 * (`null`), and a single row with a NULL version id is a model with no matching version
 * (`{ modelVersions: [] }`).
 */
export async function readDefaultModelVersionsViaKysely(
  db: Kysely<DB>,
  input: DefaultModelVersionInput
): Promise<DefaultModelVersionRead> {
  const rows = await listDefaultModelVersionRows(db, input);
  if (!rows.length) return null;
  const modelVersions = [];
  for (const row of rows) {
    if (row.versionId === null) continue;
    modelVersions.push({
      id: row.versionId,
      status: row.versionStatus,
      publishedAt: row.versionPublishedAt,
      model: {
        id: row.modelId,
        userId: row.modelUserId,
        availability: row.modelAvailability,
        status: row.modelStatus,
      },
      availability: row.versionAvailability,
      trainingStatus: row.versionTrainingStatus,
    });
  }
  return { modelVersions } as NonNullable<DefaultModelVersionRead>;
}

// ---------------------------------------------------------------------------------------------
// Three reads `getModelHandler` (model.controller.ts) makes after the model row.

/** The Prisma read, unchanged. */
export function countSuggestedResourcesViaPrisma(db: PrismaClient, modelId: number) {
  return db.modelAssociations.count({ where: { fromModelId: modelId, type: 'Suggested' } });
}

export function countSuggestedResourcesViaKysely(db: Kysely<DB>, modelId: number) {
  return countSuggestedResources(db, modelId);
}

/** The owner's `settings`, `null` for a missing user or a NULL column, as the handler reads it. */
export async function readOwnerSettingsViaPrisma(db: PrismaClient, userId: number) {
  const owner = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return (owner?.settings ?? null) as Prisma.JsonValue | null;
}

export async function readOwnerSettingsViaKysely(db: Kysely<DB>, userId: number) {
  const owner = await getUserSettings(db, userId);
  return (owner?.settings ?? null) as Prisma.JsonValue | null;
}

export type ModelPagePostsInput = { modelVersionIds: number[]; userId: number };

/** The Prisma read, unchanged. */
export function readModelPagePostsViaPrisma(
  db: PrismaClient,
  { modelVersionIds, userId }: ModelPagePostsInput
) {
  return db.post.findMany({
    where: { modelVersionId: { in: modelVersionIds }, userId },
    select: { id: true, modelVersionId: true },
    orderBy: { id: 'asc' },
  });
}

export function readModelPagePostsViaKysely(
  db: Kysely<DB>,
  input: ModelPagePostsInput
): Promise<{ id: number; modelVersionId: number | null }[]> {
  return listModelPagePosts(db, input);
}

// ---------------------------------------------------------------------------------------------
// The viewer's own pending submissions on a remix gallery (`getViewerPendingSubmissions`,
// remix-gallery.service.ts).

export type ViewerPendingPlacementsInput = {
  surface: string;
  targetType: string;
  targetId: number;
  placerId: number;
  limit: number;
};

/** The Prisma read, unchanged. */
export function readViewerPendingPlacementsViaPrisma(
  db: PrismaClient,
  { surface, targetType, targetId, placerId, limit }: ViewerPendingPlacementsInput
) {
  return db.placement.findMany({
    where: { surface, targetType, targetId, placerId, status: 'pending' },
    select: { id: true, amount: true, free: true, data: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

export type ViewerPendingPlacementRow = Awaited<
  ReturnType<typeof readViewerPendingPlacementsViaPrisma>
>[number];

export async function readViewerPendingPlacementsViaKysely(
  db: Kysely<DB>,
  input: ViewerPendingPlacementsInput
): Promise<ViewerPendingPlacementRow[]> {
  const rows = await listViewerPendingRemixPlacements(db, input);
  return rows.map((row) => ({ ...row, data: row.data as Prisma.JsonValue }));
}
