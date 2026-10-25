import { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getModelWithDetailsRow,
  listModelWithDetailsFiles,
  listModelWithDetailsVersions,
} from '@civitai/db-queries/hot-reads';
import type { modelWithDetailsSelect } from '~/server/selectors/model.selector';

export type ModelWithDetails = Prisma.ModelGetPayload<{ select: typeof modelWithDetailsSelect }>;

/**
 * The model page's `modelWithDetailsSelect` read through Kysely, in the exact shape the Prisma
 * `model.findFirst({ where: { id }, select: modelWithDetailsSelect })` returns: three statements in
 * one round trip instead of one query per relation. Behind `kysely-hot-reads-2`; the caller picks
 * the client (`getKyselyWithoutLag('model', id)`), as it picked the Prisma one.
 *
 * Parity with the Prisma read is pinned in __tests__/hot-reads-2.kysely-parity.test.ts.
 */
export async function readModelWithDetailsViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<ModelWithDetails | null> {
  const [row, versions, files] = await Promise.all([
    getModelWithDetailsRow(db, id),
    listModelWithDetailsVersions(db, id),
    listModelWithDetailsFiles(db, id),
  ]);
  if (!row) return null;

  // Grouped in row order, as Prisma attaches a relation's rows to their parent.
  const filesByVersion = new Map<number, typeof files>();
  for (const file of files) {
    const list = filesByVersion.get(file.modelVersionId) ?? [];
    list.push(file);
    filesByVersion.set(file.modelVersionId, list);
  }

  const {
    reportStatsModelId,
    reportStatsOwnershipProcessing,
    userId,
    userImage,
    userUsername,
    userDeletedAt,
    rankUserId,
    rankLeaderboardRank,
    licenses,
    metrics,
    ...model
  } = row;

  return {
    ...model,
    licenses,
    reportStats:
      reportStatsModelId !== null
        ? { ownershipProcessing: reportStatsOwnershipProcessing as number }
        : null,
    user: {
      id: userId,
      image: userImage,
      username: userUsername,
      deletedAt: userDeletedAt,
      rank: rankUserId !== null ? { leaderboardRank: rankLeaderboardRank } : null,
    },
    modelVersions: versions.map(({ licensingFee, recommendedResources, ...version }) => ({
      ...version,
      licensingFee: licensingFee === null ? null : new Prisma.Decimal(licensingFee),
      files: filesByVersion.get(version.id) ?? [],
      recommendedResources: recommendedResources.map(({ id, resourceId, settings }) => ({
        id,
        resource: { id: resourceId },
        settings,
      })),
    })),
    metrics,
  } as ModelWithDetails;
}
