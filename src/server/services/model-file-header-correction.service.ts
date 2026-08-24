import { Prisma } from '@prisma/client';
import type { ModelFileType } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { primaryFileTypesByModelType } from '~/utils/file-display-helpers';
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
 * Precisions a safetensors header can never state, so a stored one is never overwritten.
 *
 * 🔴 The header carries a dtype, and these values are not dtypes. Two ways they hide:
 *
 * - `fp8_scaled` / `fp8_mixed` are scaling schemes layered on an F8 dtype. The header
 *   reads F8 and says nothing about the scaling.
 * - `nf4` / `nvfp4` / `int4` are packed into `U8` (bitsandbytes) or `I32` (GPTQ/AWQ),
 *   which `SAFETENSORS_DTYPE_TO_FP` deliberately leaves unmapped. The quantized bulk
 *   therefore contributes NOTHING to the vote, and the winner is whatever the auxiliary
 *   layernorm/embedding/scale tensors are — typically fp16.
 *
 * In both cases the header is SILENT, not contradicting, and taking it literally writes
 * a wrong value over a right one. It is unrecoverable rather than merely wrong: this runs
 * on read, so it re-applies over any correction the creator makes by hand.
 *
 * The list is the complement of what `getDominantFpFromDtypes` can emit — fp32, fp16,
 * bf16, fp8, mxfp8, int8. Adding a dtype to that mapper means removing its value here.
 *
 * Traded away knowingly: an earlier shape keyed on the HEADER's answer instead, which let a
 * positive mxfp8 identification (F8_E8M0 scale tensors, which the header does state)
 * overwrite a stored `fp8_scaled`. That case is now refused with the rest. Correcting a
 * mislabelled mxfp8 file is worth little; getting the list wrong in the other direction
 * destroys a creator's value permanently, because this runs on read. Prefer the refusal.
 */
const FP_HEADER_CANNOT_STATE: readonly string[] = [
  'fp8_scaled',
  'fp8_mixed',
  'nf4',
  'nvfp4',
  'int4',
];

/**
 * A type correction must never move a file OUT of the primary set for its model type.
 *
 * 🔴 The detection is heuristic and reads several architectures wrongly: an LLM's own
 * weights match `hasLlmTextEncoder` (embed_tokens + layers.N), and a vision-language
 * model's match VisionEncoder. Relabelling those to 'Text Encoder'/'CLIPVision' drops
 * the file out of `primaryFileTypesByModelType[LLM|VisionLanguage]`, so it stops being
 * the version's primary file and loses the download-path scoring bonus.
 *
 * A file that is NOT currently primary is the mis-filed case this feature exists for and
 * stays correctable. This only refuses to demote one that already is.
 */
function wouldDemoteFromPrimary(
  modelType: string | null | undefined,
  currentFileType: string | null | undefined,
  correctedType: ModelFileType
) {
  const primary = primaryFileTypesByModelType[modelType as ModelType] as
    | readonly string[]
    | undefined;
  if (!primary) return false;
  return primary.includes(currentFileType ?? '') && !primary.includes(correctedType);
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
  if (fp && fp !== currentFp && !FP_HEADER_CANNOT_STATE.includes(currentFp ?? ''))
    corrections.fp = fp;

  const type = getModelFileTypeCorrection({ detectedModelType, modelType, currentFileType });
  if (type && !wouldDemoteFromPrimary(modelType, currentFileType, type)) corrections.type = type;

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
  // 🔴 Both guards below are per-column and belong in the SET/WHERE, not around the call.
  const changed: Prisma.Sql[] = [];

  if (fp) {
    assignments.push(
      Prisma.sql`"metadata" = COALESCE(NULLIF("metadata", 'null'::jsonb), '{}'::jsonb) || ${JSON.stringify(
        { fp }
      )}::jsonb`
    );
    // The shape guard only gates the jsonb merge — a `type`-only correction has nothing
    // to do with metadata, and gating it on this made a row with scalar metadata issue an
    // UPDATE matching 0 rows on every single read, forever.
    changed.push(
      Prisma.sql`(
        ("metadata" IS NULL OR "metadata" = 'null'::jsonb OR jsonb_typeof("metadata") = 'object')
        AND "metadata"->>'fp' IS DISTINCT FROM ${fp}
      )`
    );
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
