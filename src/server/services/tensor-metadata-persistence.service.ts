import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';

type PersistModelTensorHeaderMetadataOptions = {
  fileId: number;
  fileUrl: string;
  modelVersionId: number;
  currentWeightPrecision?: string | null;
  weightPrecision: string | null;
  currentFp?: ModelFileFp | null;
  fp?: ModelFileFp | null;
  currentFileType: string;
  correctedFileType?: string | null;
};

export async function persistModelTensorHeaderMetadata({
  fileId,
  fileUrl,
  modelVersionId,
  currentWeightPrecision,
  weightPrecision,
  currentFp,
  fp,
  currentFileType,
  correctedFileType,
}: PersistModelTensorHeaderMetadataOptions) {
  const metadataPatch: Record<string, string> = {};
  if (weightPrecision && currentWeightPrecision !== weightPrecision)
    metadataPatch.weightPrecision = weightPrecision;
  if (fp && currentFp !== fp) metadataPatch.fp = fp;

  const shouldCorrectFileType = !!correctedFileType && correctedFileType !== currentFileType;
  if (!Object.keys(metadataPatch).length && !shouldCorrectFileType) return false;

  const typeUpdate = shouldCorrectFileType
    ? Prisma.sql`, "type" = ${correctedFileType}`
    : Prisma.empty;

  const updated = await dbWrite.$executeRaw(
    Prisma.sql`
      UPDATE "ModelFile"
      SET "metadata" = COALESCE(NULLIF("metadata", 'null'::jsonb), '{}'::jsonb) ||
        ${JSON.stringify(metadataPatch)}::jsonb
        ${typeUpdate}
      WHERE "id" = ${fileId}
        AND "url" = ${fileUrl}
        AND (
          "metadata" IS NULL OR
          "metadata" = 'null'::jsonb OR
          jsonb_typeof("metadata") = 'object'
        )
    `
  );

  // The caller read stale derived fields, so clear the model-file cache even when
  // another request won the guarded write first.
  await deleteFilesForModelVersionCache(modelVersionId);
  return updated > 0;
}
