import { headBlob, NsfwLevel } from '@civitai/orchestration-client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';

export const MAX_BLOB_RATING_BATCH = 32;

/** `nsfwLevel` is null when the blob has no level yet: `NA` covers both "not scanned" and "none". */
export type BlobRating = { blobId: string; nsfwLevel: NsfwLevel | null };

const LOOKUP_TIMEOUT_MS = 5_000;

const ratedLevels = new Set<string>(Object.values(NsfwLevel).filter((l) => l !== NsfwLevel.NA));

/** A failed lookup reads as unrated, so this never blocks anything on its own. */
export async function getBlobRatingsService({
  token,
  blobIds,
}: {
  token: string;
  blobIds: string[];
}): Promise<BlobRating[]> {
  const client = createOrchestratorClient(token);
  const unique = [...new Set(blobIds)].slice(0, MAX_BLOB_RATING_BATCH);

  return Promise.all(
    unique.map(async (blobId): Promise<BlobRating> => {
      try {
        const { response } = await headBlob({
          client,
          path: { blobId },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        const level = response?.headers.get('X-NSFW-Level')?.toLowerCase();
        return { blobId, nsfwLevel: level && ratedLevels.has(level) ? (level as NsfwLevel) : null };
      } catch (error) {
        logToAxiom({
          type: 'warning',
          name: 'blob-rating-lookup-failed',
          blobId,
          error: safeError(error),
        });
        return { blobId, nsfwLevel: null };
      }
    })
  );
}
