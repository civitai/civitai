/**
 * A signed-out visitor's rollout bucket: a whole number in `[0, SIGNED_OUT_ROLLOUT_BUCKETS)`, chosen at
 * random by the browser once and kept in a first-party cookie, so a percentage rollout for signed-out
 * visitors is stable per visitor (the same answer on every page load) rather than per request.
 *
 * Why a bucket and not the evaluation's usual entity: a signed-out request evaluates a flag with the
 * one entity id `anonymous`, so a percentage rollout puts EVERY signed-out visitor in the same bucket
 * (all of them on, or none). The flags in `SIGNED_OUT_ROLLOUT_FLAGS` are evaluated with
 * `signedOutRolloutEntity(bucket)` instead (`applySignedOutRolloutFlags`).
 *
 * It is a bucket, not an identifier: 1000 values, shared by many visitors, never sent anywhere but
 * this site's own requests. The server only reads it; the browser writes it
 * (`ensureSignedOutRolloutBucket`), so no response sets a cookie for it.
 *
 * Dependency-free: read on the server (`_app`'s `getInitialProps`, the page-data routes) and written
 * in the browser.
 */
export const SIGNED_OUT_ROLLOUT_COOKIE = 'civitai-so-bucket';

/** How many buckets there are: a rollout percentage moves in steps of 0.1%. */
export const SIGNED_OUT_ROLLOUT_BUCKETS = 1000;

/** One year, in seconds. */
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

const BUCKET_PATTERN = /^(?:0|[1-9][0-9]{0,2})$/;

/** The bucket a cookie value names, or `null` for anything that is not one (absent included). */
export function parseSignedOutRolloutBucket(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !BUCKET_PATTERN.test(value)) return null;
  const bucket = Number(value);
  return bucket < SIGNED_OUT_ROLLOUT_BUCKETS ? bucket : null;
}

/** The bucket in a `Cookie` request header, or `null` when it carries none (or an invalid one). */
export function readSignedOutRolloutBucket(cookieHeader: string | string[] | null | undefined) {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SIGNED_OUT_ROLLOUT_COOKIE) continue;
    return parseSignedOutRolloutBucket(part.slice(eq + 1).trim());
  }
  return null;
}

/** The flag-evaluation entity id of a bucket. */
export function signedOutRolloutEntity(bucket: number): string {
  return `signed-out-${bucket}`;
}

type CookieJar = { cookie: string };

/**
 * Writes this browser's bucket once, if it has none yet; an existing valid bucket is never replaced,
 * so the visitor keeps it. The first page load of a new visitor has no bucket when it is rendered,
 * so its flags are off; the bucket counts from the next page load.
 */
export function ensureSignedOutRolloutBucket(
  jar: CookieJar | undefined = typeof document !== 'undefined' ? document : undefined,
  random: () => number = Math.random,
  secure: boolean = typeof location !== 'undefined' && location.protocol === 'https:'
): number | null {
  if (!jar) return null;
  const existing = readSignedOutRolloutBucket(jar.cookie);
  if (existing !== null) return existing;
  const bucket = Math.min(
    SIGNED_OUT_ROLLOUT_BUCKETS - 1,
    Math.floor(random() * SIGNED_OUT_ROLLOUT_BUCKETS)
  );
  jar.cookie =
    `${SIGNED_OUT_ROLLOUT_COOKIE}=${bucket}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax` +
    (secure ? '; Secure' : '');
  return bucket;
}
