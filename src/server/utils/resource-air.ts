import { getPrimaryFile } from '~/server/utils/model-helpers';
import { stringifyAIR } from '~/shared/utils/air';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';

export type GenerationFileCandidate = {
  id: number;
  type: string;
  metadata: BasicFileMetadata;
  visibility: string;
  /** Absent when the caller's query already excluded replaced files. */
  replacedAt?: Date | null;
};

export const generationFileSelect = {
  id: true,
  type: true,
  metadata: true,
  visibility: true,
  replacedAt: true,
} as const;

/**
 * The file the orchestrator loads for a version, and so the one its AIR describes. Every surface
 * that builds, submits or invalidates a generation AIR must choose through here — pinned by
 * `no-divergent-generation-file.test.ts`.
 *
 * Public files only when there are any, because the orchestrator reads the mini endpoint with no
 * user and is served nothing else. Ties go to the oldest file rather than to query row order.
 */
export function getGenerationFile<T extends GenerationFileCandidate>(
  files: T[],
  preferences?: Parameters<typeof getPrimaryFile>[1]
): T | null {
  const current = files.filter((file) => file.replacedAt == null);
  const publicFiles = current.filter((file) => file.visibility === ModelFileVisibility.Public);
  const pool = (publicFiles.length ? publicFiles : current).sort((a, b) => a.id - b.id);
  return getPrimaryFile(pool, preferences) ?? null;
}

export type ModelVersionAirInput = {
  id: number;
  baseModel: string;
  model: { id: number; type: ModelType };
  files?: GenerationFileCandidate[] | null;
};

export const modelVersionAirSelect = {
  id: true,
  baseModel: true,
  model: { select: { id: true, type: true } },
  files: { select: generationFileSelect },
} as const;

/** Passing `files` can change the AIR (a Checkpoint whose generation file is a diffusion model /
 *  UNET advertises that kind — see `fileTypeUrnMap`), so a caller with files and one without are
 *  asking about different resources. */
export function modelVersionToAir({ id, baseModel, model, files }: ModelVersionAirInput) {
  const generationFile = files?.length ? getGenerationFile(files) : undefined;
  return stringifyAIR({
    baseModel,
    type: model.type,
    modelId: model.id,
    id,
    fileType: generationFile?.type,
  });
}
