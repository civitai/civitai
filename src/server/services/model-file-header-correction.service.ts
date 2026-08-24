import { Prisma } from '@prisma/client';
import type { ModelFileType } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { getDominantFpFromDtypes } from '~/utils/file-helpers';
import type {
  DetectedModelTensorType,
  ModelTensorDtypeSummary,
} from '~/utils/model-tensor-metadata';
import { getModelFileTypeCorrection } from '~/utils/model-tensor-metadata';

export type ModelFileHeaderCorrections = {
  fp?: ModelFileFp;
  type?: ModelFileType;
};

type HeaderCorrectionInput = {
  format: string | null;
  dtypeCounts: ModelTensorDtypeSummary[];
  /**
   * Absent when the caller only has a summary — `tensors[]` is dropped there, and
   * entries cached before detection existed carry no value either. Undefined means
   * "not known", which leaves `type` alone; null means "the header had no opinion".
   */
  detectedModelType?: DetectedModelTensorType | null;
  currentFp?: ModelFileFp | null;
  currentFileType?: string | null;
  modelType?: string | null;
};

type FileTarget = {
  fileId: number;
  fileUrl: string;
  modelVersionId: number;
};

/**
 * Stored precisions a given header answer does NOT contradict.
 *
 * 🔴 The header carries a dtype, and several of the values a creator can pick are
 * scaling schemes layered on one — an F8 tensor is equally an `fp8`, an `fp8_scaled`
 * or an `fp8_mixed` file. Reading "header wins" literally there rounds every one of
 * them down to plain `fp8` and destroys a distinction nothing can recover, because
 * the correction runs on read and would re-apply after any manual fix. So the header
 * only overrides a stored value it genuinely disagrees with.
 *
 * `mxfp8` is not in the fp8 set: it is identified positively, by its F8_E8M0 scale
 * tensors, so a header saying fp8 (without them) does contradict a stored mxfp8.
 */
const FP_CONSISTENT_WITH_HEADER: Record<string, readonly string[]> = {
  fp8: ['fp8', 'fp8_scaled', 'fp8_mixed'],
};

function isStoredFpConsistentWithHeader(stored: ModelFileFp | null | undefined, header: string) {
  if (!stored) return false;
  return (FP_CONSISTENT_WITH_HEADER[header] ?? [header]).includes(stored);
}

/**
 * What the tensor header says should change on a file record. Pure — split from the
 * write below so upload-time auto-detect can reuse the judgement without a database.
 */
export function getModelFileHeaderCorrections({
  format,
  dtypeCounts,
  detectedModelType,
  currentFp,
  currentFileType,
  modelType,
}: HeaderCorrectionInput): ModelFileHeaderCorrections {
  const corrections: ModelFileHeaderCorrections = {};
  if (format !== 'SafeTensor') return corrections;

  const fp = getDominantFpFromDtypes(dtypeCounts ?? []);
  if (fp && !isStoredFpConsistentWithHeader(currentFp, fp)) corrections.fp = fp;

  if (detectedModelType !== undefined) {
    const type = getModelFileTypeCorrection({ detectedModelType, modelType, currentFileType });
    if (type) corrections.type = type;
  }

  return corrections;
}

/**
 * Writes the corrections in one statement, guarded on `url` so a file whose content
 * was replaced between the header read and this write keeps its own values.
 */
export async function applyModelFileHeaderCorrections({
  fileId,
  fileUrl,
  modelVersionId,
  corrections,
}: FileTarget & { corrections: ModelFileHeaderCorrections }) {
  const { fp, type } = corrections;
  if (!fp && !type) return false;

  const assignments: Prisma.Sql[] = [];
  if (fp)
    assignments.push(
      Prisma.sql`"metadata" = COALESCE(NULLIF("metadata", 'null'::jsonb), '{}'::jsonb) || ${JSON.stringify(
        { fp }
      )}::jsonb`
    );
  if (type) assignments.push(Prisma.sql`"type" = ${type}`);

  const updated = await dbWrite.$executeRaw(
    Prisma.sql`
      UPDATE "ModelFile"
      SET ${Prisma.join(assignments, ', ')}
      WHERE "id" = ${fileId}
        AND "url" = ${fileUrl}
        AND (
          "metadata" IS NULL OR
          "metadata" = 'null'::jsonb OR
          jsonb_typeof("metadata") = 'object'
        )
    `
  );

  // Only on a real write. A 0-row result means the `url` guard rejected us — and since
  // this runs on every read of the file, busting unconditionally would re-bust the
  // version-file cache on every request for as long as the guard keeps failing.
  if (updated > 0) await deleteFilesForModelVersionCache(modelVersionId);
  return updated > 0;
}

/**
 * Derive and apply in one call. The entry point for anything holding a parsed header
 * and a file record — today the tensor-metadata endpoint, next the upload path.
 */
export async function correctModelFileFromTensorHeader({
  fileId,
  fileUrl,
  modelVersionId,
  ...input
}: FileTarget & HeaderCorrectionInput) {
  const corrections = getModelFileHeaderCorrections(input);
  const applied = await applyModelFileHeaderCorrections({
    fileId,
    fileUrl,
    modelVersionId,
    corrections,
  });

  return { corrections, applied };
}
