import { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getModelWithDetailsRow,
  listModelGenerationCoverage,
  listModelWithDetailsFiles,
  listModelWithDetailsVersions,
} from '@civitai/db-queries/hot-reads';
import type { modelWithDetailsSelect } from '~/server/selectors/model.selector';

export type ModelWithDetails = Prisma.ModelGetPayload<{ select: typeof modelWithDetailsSelect }>;

/**
 * The model page's `modelWithDetailsSelect` read through Kysely, in the exact shape the Prisma
 * `model.findFirst({ where: { id }, select: modelWithDetailsSelect })` returns: at most four
 * statements instead of one query per relation, run ONE AFTER ANOTHER on ONE pooled connection
 * (`db.connection()`), so a model page holds a single connection, as the Prisma read did. A missing
 * model stops after the first statement; a model with no versions after the second. Behind
 * `kysely-hot-reads-2`; the caller picks the client (`getKyselyWithoutLag('model', id)`), as it
 * picked the Prisma one.
 *
 * Every VIEW is read by its key as a parameter ("ModelReportStat" and "GenerationCoverage" by the
 * model id), never through a join: see hot-reads.db.ts. Parity with the Prisma read, and the plans
 * of the view reads, are pinned in __tests__/hot-reads-2.kysely-parity.test.ts.
 */
export async function readModelWithDetailsViaKysely(
  db: Kysely<DB>,
  id: number
): Promise<ModelWithDetails | null> {
  return db.connection().execute(async (conn) => {
    const row = await getModelWithDetailsRow(conn, id);
    if (!row) return null;
    const versions = await listModelWithDetailsVersions(conn, id);
    const versionIds = versions.map((version) => version.id);
    const coverage = versionIds.length ? await listModelGenerationCoverage(conn, id) : [];
    const files = await listModelWithDetailsFiles(conn, versionIds);
    return toModelWithDetails(row, versions, coverage, files);
  });
}

function toModelWithDetails(
  row: NonNullable<Awaited<ReturnType<typeof getModelWithDetailsRow>>>,
  versions: Awaited<ReturnType<typeof listModelWithDetailsVersions>>,
  coverage: Awaited<ReturnType<typeof listModelGenerationCoverage>>,
  files: Awaited<ReturnType<typeof listModelWithDetailsFiles>>
): ModelWithDetails {
  const coverageByVersion = new Map(
    coverage.map(({ modelVersionId, covered, coveredNext }) => [
      modelVersionId,
      { covered, coveredNext },
    ])
  );

  // Grouped in row order, as Prisma attaches a relation's rows to their parent.
  const filesByVersion = new Map<number, typeof files>();
  for (const file of files) {
    const list = filesByVersion.get(file.modelVersionId) ?? [];
    list.push(file);
    filesByVersion.set(file.modelVersionId, list);
  }

  const {
    reportStats,
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
    reportStats: reportStats ?? null,
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
      generationCoverage: coverageByVersion.get(version.id) ?? null,
      recommendedResources: recommendedResources.map(({ id, resourceId, settings }) => ({
        id,
        resource: { id: resourceId },
        settings,
      })),
    })),
    metrics,
  } as ModelWithDetails;
}
