import type { BlobArchiveEntry } from '@civitai/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { TrainingResults } from '~/server/schema/model-file.schema';
import {
  createBlobArchive,
  MAX_BLOB_ARCHIVE_ENTRIES,
} from '~/server/services/orchestrator/blobArchive';
import { resolveTrainingRun } from '~/server/services/orchestrator/training/training-state';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';
import type { TrainingRunNameParts } from '~/shared/utils/training-file-names';
import {
  trainingEpochModelFileName,
  trainingEpochSampleFileName,
  trainingRunArchiveName,
} from '~/shared/utils/training-file-names';

type NormalizedEpoch = { epochNumber: number; modelUrl: string; sampleImages: string[] };

export function normalizeEpochs(trainingResults: TrainingResults): NormalizedEpoch[] {
  return (trainingResults.epochs ?? []).map((epoch) =>
    'epoch_number' in epoch
      ? {
          epochNumber: epoch.epoch_number,
          modelUrl: epoch.model_url,
          sampleImages: epoch.sample_images?.map((s) => s.image_url) ?? [],
        }
      : {
          epochNumber: epoch.epochNumber,
          modelUrl: epoch.modelUrl,
          sampleImages: epoch.sampleImages ?? [],
        }
  );
}

/** Blob ids carry the original extension (`ABC123.jpeg`), which is all we know about the media type. */
function extensionOf(blobId: string) {
  const dot = blobId.lastIndexOf('.');
  return dot > 0 ? blobId.slice(dot) : '';
}

export type TrainingEpochArchiveEntries = {
  entries: BlobArchiveEntry[];
  /** Files whose URL is not an orchestrator blob, so there is nothing left to fetch. */
  unresolvedCount: number;
  /** Files that still exist but did not fit under the archive's entry cap. */
  cappedCount: number;
};

/**
 * Epoch models first, then sample media, both ascending by epoch. Ordering is what
 * decides the contents when a run has more blobs than one archive can hold, and the
 * model files are the part a user cannot regenerate.
 */
export function buildEpochArchiveEntries({
  trainingResults,
  modelName,
  versionId,
  architecture,
  maxEntries = MAX_BLOB_ARCHIVE_ENTRIES,
}: TrainingRunNameParts & {
  trainingResults: TrainingResults;
  maxEntries?: number;
}): TrainingEpochArchiveEntries {
  const epochs = [...normalizeEpochs(trainingResults)].sort(
    (a, b) => a.epochNumber - b.epochNumber
  );
  const run = { modelName, versionId, architecture };
  const candidates: Array<{ url: string; fileName: (blobId: string) => string }> = [];
  for (const epoch of epochs) {
    candidates.push({
      url: epoch.modelUrl,
      fileName: () => trainingEpochModelFileName({ ...run, epochNumber: epoch.epochNumber }),
    });
  }
  for (const epoch of epochs) {
    epoch.sampleImages.forEach((url, index) => {
      // A failed sample's '' slot was never produced, so it isn't an unresolved file.
      if (!url) return;
      candidates.push({
        url,
        fileName: (blobId) =>
          trainingEpochSampleFileName(
            { ...run, epochNumber: epoch.epochNumber, sampleNumber: index + 1 },
            extensionOf(blobId)
          ),
      });
    });
  }

  const entries: BlobArchiveEntry[] = [];
  const seen = new Set<string>();
  let unresolvedCount = 0;
  let cappedCount = 0;

  for (const candidate of candidates) {
    const blobId = candidate.url ? getConsumerBlobId(candidate.url) : undefined;
    if (!blobId || seen.has(blobId)) {
      if (!blobId) unresolvedCount++;
      continue;
    }
    if (entries.length >= maxEntries) {
      cappedCount++;
      continue;
    }
    seen.add(blobId);
    entries.push({ blobId, fileName: candidate.fileName(blobId) });
  }

  return { entries, unresolvedCount, cappedCount };
}

/**
 * Builds a single zip of everything a completed training run produced — every epoch's
 * model file and every sample image — and returns the orchestrator's signed URL for it.
 */
export async function getTrainingEpochArchive({
  modelVersionId,
  userId,
  isModerator,
  ctx,
}: {
  modelVersionId: number;
  userId: number;
  isModerator?: boolean;
  ctx: { req: NextApiRequest; res: NextApiResponse };
}) {
  const { state, run } = await resolveTrainingRun({
    modelVersionId,
    userId,
    isModerator: !!isModerator,
    ctx,
  });
  const trainingResults = state.trainingResults as TrainingResults | null;
  if (!trainingResults?.epochs?.length) throw throwNotFoundError('No training epochs found');

  const { entries, unresolvedCount, cappedCount } = buildEpochArchiveEntries({
    trainingResults,
    ...run,
  });
  if (!entries.length) throw throwNotFoundError('No downloadable training files found');

  const archive = await createBlobArchive({
    entries,
    archiveName: trainingRunArchiveName(run),
  });

  return {
    url: archive.url,
    entryCount: archive.entryCount,
    expiresAt: archive.expiresAt,
    unresolvedCount,
    cappedCount,
  };
}
