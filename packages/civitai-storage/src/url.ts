// Pure URL <-> { bucket, key } helpers for S3 / R2 / B2 object URLs. No env or SDK deps — safe to
// import anywhere (browser included). Host-parameterized: the S3/B2 endpoint hosts a URL is matched
// against are passed in (the client binds them from its own config), keeping these functions pure.

export type ParsedKey = { key: string; bucket?: string };

// Path-style (`<host>/<bucket>/<key>`) when the URL host matches the configured S3/B2 endpoint host;
// otherwise virtual-host style (`<bucket>.<host>/<key>`). A non-URL string is returned as a bare key.
export function parseKey(fileUrl: string, opts?: { s3Host?: string; b2Host?: string }): ParsedKey {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return { key: fileUrl };
  }

  const { s3Host, b2Host } = opts ?? {};
  const bucketInPath = url.hostname === s3Host || (!!b2Host && url.hostname === b2Host);
  if (bucketInPath) {
    const pathParts = url.pathname.split('/');
    return { key: pathParts.slice(2).join('/'), bucket: pathParts[1] };
  }

  return {
    key: url.pathname.split('/').slice(1).join('/'),
    bucket: s3Host ? url.hostname.replace('.' + s3Host, '') : url.hostname,
  };
}

// Extract `{ bucket, key }` from a Backblaze B2 URL. Primary check is the `*.backblazeb2.com`
// hostname pattern (works with no config — important for scripts running without S3_UPLOAD_B2_ENDPOINT);
// falls back to the configured `b2Host` so custom proxies / non-public endpoints still parse.
// Accepts path-style (`s3.<region>.backblazeb2.com/<bucket>/<key>`) and virtual-host style
// (`<bucket>.s3.<region>.backblazeb2.com/<key>`). Returns null if neither check recognizes the URL.
export function parseB2Url(
  rawUrl: string,
  opts?: { b2Host?: string }
): { bucket: string; key: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const b2Host = opts?.b2Host ?? null;
  const matchesPublicPattern = url.hostname.endsWith('.backblazeb2.com');
  const matchesConfiguredHost = b2Host !== null && url.hostname === b2Host;
  if (!matchesPublicPattern && !matchesConfiguredHost) return null;

  const isPathStyle = url.hostname.startsWith('s3.') || matchesConfiguredHost;
  if (isPathStyle) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { bucket: parts[0], key: parts.slice(1).join('/') };
  }

  const dotIdx = url.hostname.indexOf('.');
  if (dotIdx <= 0) return null;
  const bucket = url.hostname.slice(0, dotIdx);
  const key = url.pathname.replace(/^\/+/, '');
  if (!key) return null;
  return { bucket, key };
}

// True if the URL points at B2. Matches the public `*.backblazeb2.com` pattern OR, when set, the
// configured `b2Host` — deliberately the same predicate as parseB2Url, so `isB2Url(url) === true`
// exactly when `parseB2Url(url)` would return a value (a canonical B2 URL is recognized even when a
// custom `b2Host` proxy is configured).
export function isB2Url(url: string, b2Host?: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.backblazeb2.com') || (!!b2Host && host === b2Host);
  } catch {
    return false;
  }
}
