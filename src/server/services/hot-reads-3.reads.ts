import type { Prisma } from '@prisma/client';
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
 * The Kysely reads, each returning the shape the Prisma read returned. Each takes the client, so
 * __tests__/hot-reads-3.kysely-parity.test.ts runs the very code the services run.
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

/**
 * The model, its versions, and each version's model, as the Prisma `model.findUnique` with
 * `defaultModelVersionSelect` returned them, from ONE statement (`listDefaultModelVersionRows`): no
 * rows is a missing model (`null`), and a single row with a NULL version id is a model with no
 * matching version (`{ modelVersions: [] }`).
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

export function countSuggestedResourcesViaKysely(db: Kysely<DB>, modelId: number) {
  return countSuggestedResources(db, modelId);
}

/** The owner's `settings`, `null` for a missing user or a NULL column, as the handler reads it. */
export async function readOwnerSettingsViaKysely(db: Kysely<DB>, userId: number) {
  const owner = await getUserSettings(db, userId);
  return (owner?.settings ?? null) as Prisma.JsonValue | null;
}

export type ModelPagePostsInput = { modelVersionIds: number[]; userId: number };

/** The owner's posts on the versions, in id order. */
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

/** One of the viewer's pending rows, in the shape the Prisma `placement.findMany` returned. */
export type ViewerPendingPlacementRow = Prisma.PlacementGetPayload<{
  select: { id: true; amount: true; free: true; data: true; createdAt: true; expiresAt: true };
}>;

/** The viewer's pending rows, oldest first, capped at `limit`. */
export async function readViewerPendingPlacementsViaKysely(
  db: Kysely<DB>,
  input: ViewerPendingPlacementsInput
): Promise<ViewerPendingPlacementRow[]> {
  const rows = await listViewerPendingRemixPlacements(db, input);
  return rows.map((row) => ({ ...row, data: row.data as Prisma.JsonValue }));
}
