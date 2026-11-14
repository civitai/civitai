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

/**
 * A signed consumer blob URL's expiry (ms); undefined if it is not one or carries no usable expiry.
 * Throws on a URL that does not parse.
 */
function signedBlobExpiry(url: string): number | undefined {
  const urlObj = new URL(url);
  const sig = urlObj.searchParams.get('sig');
  const exp = urlObj.searchParams.get('exp');
  if (!sig || !exp) return undefined;
  const expiry = new Date(exp).getTime();
  return isNaN(expiry) ? undefined : expiry;
}

export function shouldRefreshBlobUrl(url: string): boolean {
  try {
    if (!CONSUMER_BLOB_RE.test(url)) return false;
    const expiry = signedBlobExpiry(url);
    // Unsigned, or an unparseable exp → treat as expired
    if (expiry === undefined) return true;
    return expiry - Date.now() < BLOB_REFRESH_BUFFER_MS;
  } catch {
    return false;
  }
}

/** When a consumer blob URL stops being usable: its expiry less the refresh buffer. */
export function blobUrlUsableUntil(url: string): number | undefined {
  try {
    if (!CONSUMER_BLOB_RE.test(url)) return undefined;
    const expiry = signedBlobExpiry(url);
    return expiry === undefined ? undefined : expiry - BLOB_REFRESH_BUFFER_MS;
  } catch {
    return undefined;
  }
}

/** blobId if this is a consumer blob URL that needs refreshing, else undefined. */
export function refreshableBlobId(url: string): string | undefined {
  const blobId = getConsumerBlobId(url);
  return blobId && shouldRefreshBlobUrl(url) ? blobId : undefined;
}

const JOB_ASSET_RE =
  /\/v\d+\/consumer\/jobs\/(?<jobId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/assets\/(?<assetName>[^/?#\s]+)/i;

/**
 * A job-asset URL (`/v1/consumer/jobs/<jobId>/assets/<file>`): the format pre-workflow training
 * jobs used, and that some workflow training runs (late Sep to mid Oct 2026) recorded for their
 * epochs instead of a blob URL.
 */
export function parseJobAssetUrl(url: string): { jobId: string; assetName: string } | undefined {
  const groups = url.match(JOB_ASSET_RE)?.groups;
  return groups ? { jobId: groups.jobId.toLowerCase(), assetName: groups.assetName } : undefined;
}
