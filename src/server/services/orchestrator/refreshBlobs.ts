import { refreshBlob } from '@civitai/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';

export const MAX_BLOB_REFRESH_BATCH = 32;

export type BlobRefreshResult =
  /** Fresh signed URL — the caller should replace the one it holds. */
  | { blobId: string; status: 'refreshed'; url: string }
  /** The orchestrator says this blob is gone or blocked — safe to forget. */
  | { blobId: string; status: 'gone' }
  /** Refresh failed for a reason that says nothing about the blob — keep it. */
  | { blobId: string; status: 'unknown' };

/**
 * Unlike the submit path's `refreshBlobUrlsInBody`, one failure here must not fail
 * the batch: this drives a UI that would otherwise delete a user's history on a
 * network blip. Only an answer from the orchestrator produces 'gone'.
 */
export async function refreshBlobsService({
  token,
  blobIds,
}: {
  token: string;
  blobIds: string[];
}): Promise<BlobRefreshResult[]> {
  const client = createOrchestratorClient(token);
  const unique = [...new Set(blobIds)].slice(0, MAX_BLOB_REFRESH_BATCH);

  return Promise.all(
    unique.map(async (blobId): Promise<BlobRefreshResult> => {
      try {
        const { data, response } = await refreshBlob({ client, path: { blobId } });
        if (response?.status === 404) return { blobId, status: 'gone' };
        if (data?.blockedReason || data?.available === false) return { blobId, status: 'gone' };
        if (!data?.url) return { blobId, status: 'unknown' };
        return { blobId, status: 'refreshed', url: data.url };
      } catch (error) {
        logToAxiom({
          type: 'warning',
          name: 'blob-refresh-batch-failed',
          blobId,
          error: safeError(error),
        });
        return { blobId, status: 'unknown' };
      }
    })
  );
}
