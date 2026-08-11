/**
 * Consumer blob URLs are presigned and expire. These helpers are shared by the
 * server submit path and by client code that needs to decide whether a stored
 * URL is still usable, so they must stay free of orchestrator-client imports.
 */

const CONSUMER_BLOB_RE = /\/v\d+\/consumer\/blobs\/(?<blobId>[a-zA-Z0-9_.-]+)/;

/** Treat a URL that expires within this window as already expired. */
export const BLOB_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function isConsumerBlobUrl(url: string): boolean {
  return CONSUMER_BLOB_RE.test(url);
}

export function getConsumerBlobId(url: string): string | undefined {
  return url.match(CONSUMER_BLOB_RE)?.groups?.blobId;
}

export function shouldRefreshBlobUrl(url: string): boolean {
  try {
    if (!CONSUMER_BLOB_RE.test(url)) return false;
    const urlObj = new URL(url);
    const sig = urlObj.searchParams.get('sig');
    const exp = urlObj.searchParams.get('exp');
    if (!sig || !exp) return true;

    const expiryDate = new Date(exp);
    if (isNaN(expiryDate.getTime())) return true; // Unparseable exp → treat as expired
    return expiryDate.getTime() - Date.now() < BLOB_REFRESH_BUFFER_MS;
  } catch {
    return false;
  }
}

/** blobId if this is a consumer blob URL that needs refreshing, else undefined. */
export function refreshableBlobId(url: string): string | undefined {
  const blobId = getConsumerBlobId(url);
  return blobId && shouldRefreshBlobUrl(url) ? blobId : undefined;
}
