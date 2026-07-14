import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';

type PersistModelWeightPrecisionOptions = {
  fileId: number;
  fileUrl: string;
  modelVersionId: number;
  currentWeightPrecision?: string | null;
  weightPrecision: string | null;
};

export async function persistModelWeightPrecision({
  fileId,
  fileUrl,
  modelVersionId,
  currentWeightPrecision,
  weightPrecision,
}: PersistModelWeightPrecisionOptions) {
  if (!weightPrecision || currentWeightPrecision === weightPrecision) return false;

  const updated = await dbWrite.$executeRaw(
    Prisma.sql`
      UPDATE "ModelFile"
      SET "metadata" = COALESCE(NULLIF("metadata", 'null'::jsonb), '{}'::jsonb) ||
        jsonb_build_object('weightPrecision', ${weightPrecision})
      WHERE "id" = ${fileId}
        AND "url" = ${fileUrl}
        AND (
          "metadata" IS NULL OR
          "metadata" = 'null'::jsonb OR
          jsonb_typeof("metadata") = 'object'
        )
        AND ("metadata"->>'weightPrecision') IS DISTINCT FROM ${weightPrecision}
    `
  );

  // The caller read metadata without this value, so clear the model-file cache even
  // when the write was a no-op because another request persisted it first.
  await deleteFilesForModelVersionCache(modelVersionId);
  return updated > 0;
}
