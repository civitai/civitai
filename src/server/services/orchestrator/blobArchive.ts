import type { BlobArchiveEntry, BlobArchiveOutput } from '@civitai/client';
import { invokeBlobArchiveStepTemplate } from '@civitai/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { throwBadRequestError, throwInternalServerError } from '~/server/utils/errorHandling';

/** The orchestrator rejects a blobArchive step with more entries than this. */
export const MAX_BLOB_ARCHIVE_ENTRIES = 1000;

/**
 * Asks the orchestrator to bundle a set of blobs into one archive and returns the
 * signed URL that streams it. The step runs in-process on the orchestrator, so the
 * archive is never buffered or proxied through us.
 */
export async function createBlobArchive({
  entries,
  archiveName,
}: {
  entries: BlobArchiveEntry[];
  archiveName?: string;
}): Promise<BlobArchiveOutput> {
  if (!entries.length) throw throwBadRequestError('No blobs to archive');
  if (entries.length > MAX_BLOB_ARCHIVE_ENTRIES)
    throw throwBadRequestError(`Cannot archive more than ${MAX_BLOB_ARCHIVE_ENTRIES} blobs`);

  const { data, error } = await invokeBlobArchiveStepTemplate({
    client: internalOrchestratorClient,
    body: { entries, archiveName, format: 'zip' },
  });

  if (!data) {
    const messages = (error as { errors?: { messages?: string[] } })?.errors?.messages?.join('\n');
    const detail = messages ?? (error as { detail?: string })?.detail;
    if (error?.status === 400) throw throwBadRequestError(detail ?? 'Unable to build archive');
    throw throwInternalServerError(detail ?? 'Unable to build archive');
  }

  return data;
}
