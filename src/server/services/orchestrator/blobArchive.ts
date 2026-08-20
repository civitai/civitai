import type { BlobArchiveEntry, BlobArchiveOutput } from '@civitai/client';
import { invokeBlobArchiveStepTemplate } from '@civitai/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  isUpstreamNetworkError,
  isUpstreamServerOrNetworkError,
  throwBadRequestError,
  throwInternalServerError,
  throwServiceUnavailableError,
} from '~/server/utils/errorHandling';

/** The orchestrator rejects a blobArchive step with more entries than this. */
export const MAX_BLOB_ARCHIVE_ENTRIES = 1000;

const ARCHIVE_UNAVAILABLE_MESSAGE =
  'Archive services are temporarily unavailable. Please try again.';

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
  }).catch((thrown) => {
    // A rejected call never carries an HTTP status. A recognized network failure is a
    // transient upstream outage → retry-able 503; anything else is a real bug on our
    // side and is left to surface as a 500.
    if (isUpstreamNetworkError(thrown))
      throw throwServiceUnavailableError(ARCHIVE_UNAVAILABLE_MESSAGE, thrown);
    throw thrown;
  });

  if (!data) {
    const messages = (error as { errors?: { messages?: string[] } })?.errors?.messages?.join('\n');
    const detail = messages ?? (error as { detail?: string })?.detail;
    if (error?.status === 400) throw throwBadRequestError(detail ?? 'Unable to build archive');
    // An upstream 5xx is a dependency outage, not our fault — surface it as a
    // retry-able 503 rather than a 500 the client cannot act on.
    if (isUpstreamServerOrNetworkError({ clientError: error, thrown: error }))
      throw throwServiceUnavailableError(ARCHIVE_UNAVAILABLE_MESSAGE, error);
    // Any other 4xx is a client/validation fault; keep it 4xx instead of flattening to 500.
    if (typeof error?.status === 'number' && error.status > 400 && error.status < 500)
      throw throwBadRequestError(detail ?? 'Unable to build archive');
    // `throwInternalServerError` reads `.message` off what it's given, so hand it an
    // Error carrying the orchestrator's detail — a bare string loses it.
    throw throwInternalServerError(
      new Error(detail ?? 'Unable to build archive', { cause: error })
    );
  }

  return data;
}
