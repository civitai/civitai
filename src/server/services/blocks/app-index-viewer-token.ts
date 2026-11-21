/**
 * The viewer token the site sends with a listing request to the app index's read model
 * (`apps/app-index-go`, README "Listing API"; `internal/listingread/viewer.go` is the verifier).
 *
 * The read model never decides who is looking: the site sends the audience it resolved for its own
 * database read, signed with a key the two share. So the token is built from the very options
 * object the database read is given (`ListAvailableListingsOpts`), read with the same defaults the
 * database read applies to it:
 *   - `host` is `red` when `redCapable` is true (absent is false, as `listAvailableListings` reads
 *     it);
 *   - `level` is `viewerBrowsingLevel` (absent is 0, the public floor, as `matureRatingsAllowed`
 *     and the media ceiling read it);
 *   - `scope` is `narrowStoreScope(scope)`, so an absent or unknown scope is `none`, as the
 *     database read narrows it.
 *
 * Only a `public`-floor viewer has a token. A tester or moderator floor admits listings the read
 * model does not hold, so those viewers stay on the database (LISTINGS-READ-MODEL.md, "Visibility").
 * A level the token cannot carry exactly (not an integer from 0 to 63) has none either: such a
 * viewer is answered from the database, never from a level rounded into range.
 */
import { createHmac } from 'node:crypto';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';
import { narrowStoreScope, type StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/** The request header the read model reads the token from. */
export const APP_INDEX_VIEWER_HEADER = 'X-App-Index-Viewer';

/** The shortest key the read model accepts (bytes): the size of an HMAC-SHA256 output. */
export const APP_INDEX_VIEWER_MIN_KEY_BYTES = 32;

/**
 * How long a token is valid for. One is signed per request; the read model refuses one valid for
 * more than 5 minutes, and allows 30 seconds of clock skew either way.
 */
export const APP_INDEX_VIEWER_TTL_SECONDS = 60;

/** Every NsfwLevel bit, Blocked included (which every gate masks off), and no more. */
const MAX_LEVEL = 63;

/** What a token carries: the audience the database read is answered for. */
export type AppIndexViewer = {
  host: 'main' | 'red';
  level: number;
  scope: StoreVisibilityScope;
};

/**
 * The audience `opts` gives the database read, as a token carries it; null when the read model
 * must not answer this viewer (a floor other than `public`, or a level outside 0 to 63).
 */
export function appIndexViewerFor(
  opts: Pick<ListAvailableListingsOpts, 'redCapable' | 'scope' | 'floor' | 'viewerBrowsingLevel'>
): AppIndexViewer | null {
  if ((opts.floor ?? 'public') !== 'public') return null;
  const level = opts.viewerBrowsingLevel ?? 0;
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) return null;
  return {
    host: opts.redCapable ?? false ? 'red' : 'main',
    level,
    scope: narrowStoreScope(opts.scope),
  };
}

/** Whether `key` is long enough for the read model to verify a token signed with it. */
export function appIndexViewerKeyUsable(key: string | undefined): key is string {
  return !!key && Buffer.byteLength(key, 'utf8') >= APP_INDEX_VIEWER_MIN_KEY_BYTES;
}

/**
 * The token for `viewer`, valid until `expSeconds` (Unix seconds):
 *
 *   v1.<payload>.<signature>
 *   payload   = base64url, unpadded, of {"host","level","scope","exp"}
 *   signature = base64url, unpadded, of HMAC-SHA256(key, "v1." + payload)
 */
export function signAppIndexViewer(
  key: string,
  viewer: AppIndexViewer,
  expSeconds: number
): string {
  const payload = JSON.stringify({
    host: viewer.host,
    level: viewer.level,
    scope: viewer.scope,
    exp: expSeconds,
  });
  const signed = `v1.${Buffer.from(payload, 'utf8').toString('base64url')}`;
  return `${signed}.${createHmac('sha256', key).update(signed).digest('base64url')}`;
}
