import { refreshableBlobId } from '~/shared/orchestrator/blob-url';

type BlobRefreshResult =
  | { blobId: string; status: 'refreshed'; url: string }
  | { blobId: string; status: 'gone' }
  | { blobId: string; status: 'unknown' };

export type BlobUrlRefresh = { status: 'refreshed'; url: string } | { status: 'gone' };

/**
 * Fresh links for the expired consumer-blob urls among `urls`, keyed by the url passed in. A url
 * missing from the result was not settled (offline, 5xx, blocked request): a failed refresh is not
 * evidence the blob is gone.
 */
export async function refreshBlobUrls(urls: string[]): Promise<Map<string, BlobUrlRefresh>> {
  const settled = new Map<string, BlobUrlRefresh>();
  const urlByBlobId = new Map<string, string>();
  for (const url of urls) {
    const blobId = refreshableBlobId(url);
    if (blobId) urlByBlobId.set(blobId, url);
  }
  if (!urlByBlobId.size) return settled;

  try {
    const response = await fetch('/api/orchestrator/refreshBlobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blobIds: [...urlByBlobId.keys()] }),
    });
    if (!response.ok) return settled;

    const { results } = (await response.json()) as { results?: BlobRefreshResult[] };
    if (!Array.isArray(results)) return settled;

    for (const result of results) {
      const url = urlByBlobId.get(result.blobId);
      if (!url) continue;
      if (result.status === 'refreshed') settled.set(url, { status: 'refreshed', url: result.url });
      else if (result.status === 'gone') settled.set(url, { status: 'gone' });
    }
  } catch {}
  return settled;
}
