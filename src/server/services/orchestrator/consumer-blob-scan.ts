import { env } from '~/env/server';

/** The AIR a scan step takes for a consumer blob. */
export const blobAir = (blobId: string) => `urn:air:other:other:orchestrator:blob@${blobId}`;

/**
 * Streams bytes to the orchestrator as a consumer blob owned by the service account, and returns
 * its id. The orchestrator offers no way to delete the blob; it expires on its own.
 */
export async function uploadConsumerBlob({
  body,
  size,
  timeoutMs,
}: {
  body: ReadableStream;
  size: number;
  timeoutMs: number;
}) {
  const response = await fetch(
    `${env.ORCHESTRATOR_ENDPOINT?.replace(/\/$/, '')}/v2/consumer/blobs`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      },
      body,
      duplex: 'half',
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit
  );
  if (!response.ok) throw new Error(`Blob upload failed: ${response.status}`);
  const { id } = (await response.json()) as { id?: string };
  if (!id) throw new Error('Blob upload returned no id');
  return id;
}

/**
 * How many files a virus scan says it read: scannedFileCount when reported, else the count in the
 * scanner's summary line. Zero when it says neither. A clean scan that read nothing has not cleared
 * the file.
 */
export function clamFilesScanned(clam: {
  scannedFileCount?: number | null;
  output?: string | null;
}) {
  if (typeof clam.scannedFileCount === 'number') return clam.scannedFileCount;
  const summary = /^Scanned files:\s*(\d+)\s*$/m.exec(clam.output ?? '');
  return summary ? Number(summary[1]) : 0;
}
