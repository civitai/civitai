import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import type { GetByIdInput } from '~/server/schema/base.schema';

/** What the nested selects `generationCoverage: { select: { covered, coveredNext } }` and
 * `recommendedResources: { select: { id, resource: { select: { id } }, settings } }` return. */
export type VersionGenerationChildren = {
  generationCoverage: { covered: boolean; coveredNext: boolean } | null;
  recommendedResources: { id: number; resource: { id: number }; settings: Prisma.JsonValue }[];
};

/**
 * One statement for a version's coverage row and recommended resources. As nested Prisma selects
 * they cost one statement each, plus one more for the resource's ModelVersion when the version has
 * recommended resources (only to read its id, which is `resourceId`). Key order matches the nested
 * select. `resourceId` is a NOT NULL foreign key, so `resource.id` is always that value.
 */
export const versionGenerationChildrenSql = (id: number) => Prisma.sql`
  SELECT
    (
      SELECT json_build_object('covered', gc."covered", 'coveredNext', gc."coveredNext")
      FROM "GenerationCoverage" gc
      WHERE gc."modelVersionId" = ${id}::int
    ) AS "generationCoverage",
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', rr."id",
            'resource', json_build_object('id', rr."resourceId"),
            'settings', rr."settings"
          )
        )
        FROM "RecommendedResource" rr
        WHERE rr."sourceId" = ${id}::int
      ),
      '[]'::json
    ) AS "recommendedResources"
`;

/**
 * `getVersionById` plus the version's `generationCoverage` and `recommendedResources`, read with
 * one raw statement on the SAME client (same lag decision) in parallel with the version row,
 * instead of 2-3 nested Prisma statements. Returns `null` for a missing version, like
 * `getVersionById`.
 */
export const getVersionByIdWithGenerationChildren = async <
  TSelect extends Omit<Prisma.ModelVersionSelect, keyof VersionGenerationChildren>
>({
  id,
  select,
  forceWriteDb,
}: GetByIdInput & { select: TSelect; forceWriteDb?: boolean }) => {
  const db = forceWriteDb ? dbWrite : await getDbWithoutLag('modelVersion', id);
  const [version, children] = await Promise.all([
    db.modelVersion.findUnique({ where: { id }, select }),
    db.$queryRaw<VersionGenerationChildren[]>(versionGenerationChildrenSql(id)),
  ]);
  if (!version) return null;
  const [row] = children;
  return {
    ...version,
    generationCoverage: row?.generationCoverage ?? null,
    recommendedResources: row?.recommendedResources ?? [],
  };
};
