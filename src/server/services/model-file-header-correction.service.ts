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
 * 🔴 The test is SILENCE, not "can the mapper emit it". Those come apart, and where they
 * do the emittable-means-safe proxy fails open:
 *
 * - `mxfp8` is emittable but is not a dtype either — it is inferred from F8_E8M0-typed
 *   scale tensors. An exporter that stores those scales as `U8` (permitted: E8M0 is
 *   byte-wide) leaves no signal, the vote returns plain `fp8`, and a correct value is lost.
 * - `int8` is emittable from `I8`, but GPTQ/AWQ at 8 bits packs into the unmapped `I32` —
 *   the same mechanism as int4, with leftover fp16 tensors winning the vote.
 *
 * Both are on the list for that reason. The cost is only that a file ALREADY labelled
 * mxfp8 or int8 is never re-corrected; an empty `fp` is still filled from the header, and
 * a wrong fp32/fp16/bf16/fp8 is still fixed.
 *
 * Traded away knowingly: keying on the HEADER's answer instead would let a positive mxfp8
 * identification overwrite a stored `fp8_scaled`. Correcting a mislabelled file is worth
 * little next to destroying a right value permanently, and this runs on read, so a bad
 * overwrite re-applies over any manual fix. Prefer the refusal in both directions.
 */
const FP_HEADER_CANNOT_STATE: readonly string[] = [
  'fp8_scaled',
  'fp8_mixed',
  'mxfp8',
  'int8',
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
