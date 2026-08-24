import { Prisma } from '@prisma/client';
import type { ModelFileType } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { bustFullTensorAnalysis } from '~/server/services/tensor-metadata.service';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
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
  /** Absent when the caller has only a summary, or a cache entry predating detection. */
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
 * The only stored precisions a safetensors header is allowed to overwrite.
 *
 * 🔴 Stated as an ALLOW-list on purpose. The obvious shape is a deny-list of values the
 * header cannot express, and that shape is unsafe here: `constants.modelFileFp` is only a
 * FALLBACK — precisions are mod-managed at runtime through `modelFileOptions`
 * (`model-file.service.ts` `getModelFileOptions` / `addModelFileOptions`). A deny-list
 * silently stops covering every precision a mod adds after it is written, and since this
 * correction runs on READ, the first overwrite re-applies over any manual fix. Inverted,
 * an unknown precision is refused by construction and the list cannot drift.
 *
 * These four are exactly the values a dtype can state. Everything else is refused because
 * the header is SILENT about it, not because it disagrees:
 *
 * - `fp8_scaled` / `fp8_mixed` are scaling schemes layered on an F8 dtype.
 * - `nf4` / `nvfp4` / `int4`, and GPTQ/AWQ `int8`, pack into `U8` / `I32`, which
 *   `SAFETENSORS_DTYPE_TO_FP` deliberately leaves unmapped — so the quantized bulk
 *   contributes NOTHING to the byte-share vote and the winner is whatever leftover fp16
 *   housekeeping tensors are present.
 * - `mxfp8` and `int8` ARE emittable, and are still excluded: mxfp8 is inferred from
 *   F8_E8M0 scale tensors an exporter may store as `U8` instead, and true `I8` cannot be
 *   told from the GPTQ case. Correcting a file already labelled with one is worth little
 *   next to overwriting a right value permanently.
 *
 * An absent `fp` is always fillable — that is the backlog this feature exists for.
 */
const FP_HEADER_MAY_REPLACE: readonly string[] = ['fp32', 'fp16', 'bf16', 'fp8'];

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
  if (fp && fp !== currentFp && (!currentFp || FP_HEADER_MAY_REPLACE.includes(currentFp)))
    corrections.fp = fp;

  const type = getModelFileTypeCorrection({ detectedModelType, modelType, currentFileType });
  if (type) corrections.type = type;

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
  const changed: Prisma.Sql[] = [];
  const metadataIsObject = Prisma.sql`(
    "metadata" IS NULL OR "metadata" = 'null'::jsonb OR jsonb_typeof("metadata") = 'object'
  )`;

  if (fp) {
    // 🔴 The shape guard travels with the ASSIGNMENT, not with the row match, and the CASE
    // is what makes that true. Putting it only in the WHERE looks equivalent and is not:
    // the branches are OR-ed, so a row matched on its `type` branch alone still runs this
    // merge — and `'"legacy"'::jsonb || '{...}'::jsonb` raises on a scalar, while a jsonb
    // ARRAY concatenates silently and appends the object as an element, corrupting the
    // column with nothing to log. Reached only by an fp AND type correction together.
    assignments.push(
      Prisma.sql`"metadata" = CASE WHEN ${metadataIsObject}
        THEN COALESCE(NULLIF("metadata", 'null'::jsonb), '{}'::jsonb) || ${JSON.stringify({
          fp,
        })}::jsonb
        ELSE "metadata" END`
    );
    // Kept in the WHERE too, so an fp-only correction we cannot apply does not match the
    // row at all. Gating the TYPE branch on it was the bug: a scalar-metadata row then
    // issued an UPDATE matching 0 rows on every read, forever.
    changed.push(Prisma.sql`(${metadataIsObject} AND "metadata"->>'fp' IS DISTINCT FROM ${fp})`);
  }
  if (type) {
    assignments.push(Prisma.sql`"type" = ${type}`);
    changed.push(Prisma.sql`"type" IS DISTINCT FROM ${type}`);
  }

  const updated = await dbWrite.$executeRaw(
    Prisma.sql`
      UPDATE "ModelFile"
      SET ${Prisma.join(assignments, ', ')}
      WHERE "id" = ${fileId}
        AND "url" = ${fileUrl}
        AND (${Prisma.join(changed, ' OR ')})
    `
  );

  // 🔴 `updated` is rows MATCHED, not rows whose values differed — Postgres reports a
  // no-op UPDATE as 1. The `IS DISTINCT FROM` predicates above are what make this mean
  // "something actually changed". Without them, every concurrent viewer inside the
  // replica-lag window after the first correction rewrites the same values and busts the
  // cache again: N dead tuples and N busts per window on a hot file.
  if (updated === 0) return false;

  await deleteFilesForModelVersionCache(modelVersionId);

  // 🔴 `file.type` is an INPUT to the cached analysis, not just a field beside it:
  // `supportsTensorVramEstimate` gates `vramEstimate` on it, and neither tensor cache key
  // varies with type. Correcting the type into or out of the weights-file set therefore
  // pins a `vramEstimate` that is now wrong for a month in redis — and up to a year at the
  // CDN, since the 200 carries `immutable`. Only on a type change; precision is not an input.
  if (type) {
    bustFullTensorAnalysis(fileId);
    await Promise.all([
      bustFetchThroughCache(`${REDIS_KEYS.CACHES.TENSOR_METADATA}:${fileId}`, { compress: true }),
      bustFetchThroughCache(`${REDIS_KEYS.CACHES.TENSOR_METADATA_SUMMARY}:${fileId}`),
    ]);
  }

  return true;
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
