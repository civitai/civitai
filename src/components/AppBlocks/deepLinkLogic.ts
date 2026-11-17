import { stripHostOwnedRunParams } from '~/shared/utils/apps-run-origin';
import { resolveNavigateRequest } from './pageBlockHostLogic';

/**
 * Deep links into app state: the pure rules behind the page host's deep-link and share-link
 * bridges. `PageBlockHost` owns the wiring; everything here is pure so it can be unit-tested
 * (`__tests__/deepLinkLogic.test.ts`).
 */

/**
 * Longest `subPath`, `search` or `hash` an app may put in a SHARE_LINK. Longer is REFUSED,
 * never truncated: a truncated query is a different, wrong link. Inbound only — the host
 * forwards its own URL's search and hash to the app uncapped (`resolveBridgeLocation`).
 */
export const SHARE_LINK_MAX_FIELD_LENGTH = 2048;

const LOCATION_SENTINEL_ORIGIN = 'https://page-block-host.invalid';

/**
 * The `search` and `hash` of the host URL, as the block should see them.
 *
 * - Read from `router.asPath`, which is what the address bar shows, through the WHATWG
 *   parser, so control characters arrive percent-encoded, never raw.
 * - Every host-owned pair (`HOST_OWNED_RUN_PARAMS`: `from`, `sl`, `src`, any spelling) is
 *   removed: the block never wrote them, and host attribution must not reach it. Every other
 *   pair keeps its bytes and order.
 * - `search` is `''` or starts with `?`; `hash` is `''` or starts with `#`. No length cap:
 *   this is the host's own URL, already bounded by what the browser and the server accept,
 *   and a capped value would hand the app a deep link that silently lost its state.
 *
 * These are separate fields from `subPath` (which still comes from `router.query.path`), so
 * nothing in them can change the slug or the path prefix the block sees.
 */
export function resolveBridgeLocation(asPath: string): { search: string; hash: string } {
  let url: URL;
  try {
    url = new URL(stripHostOwnedRunParams(asPath), LOCATION_SENTINEL_ORIGIN);
  } catch {
    return { search: '', hash: '' };
  }
  return { search: url.search, hash: url.hash };
}

// ── SHARE_LINK ──────────────────────────────────────────────────────────────

export const SHARE_LINK_INVALID_ERROR = 'invalid share link';
export const SHARE_LINK_UNAVAILABLE_ERROR = 'sharing is not available here';
export const SHARE_LINK_NOT_READY_ERROR = 'the app is not ready yet';
export const SHARE_LINK_RATE_LIMITED_ERROR = 'rate_limited';

export type ShareLinkMethod = 'clipboard' | 'share' | 'none';
export type ShareLinkResult = { url: string; copied: boolean; method: ShareLinkMethod };

export type ShareLinkDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: string }
  | { kind: 'ok'; requestId: string; url: string };

function optionalString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : null;
}

/**
 * Validate a raw `SHARE_LINK { requestId, subPath?, search?, hash? }` from an untrusted
 * iframe and build the canonical absolute URL to share.
 *
 * 🔴 THE URL IS BUILT FROM THE HOST'S OWN ORIGIN, DEEP-LINK BASE AND SLUG. The app supplies
 * only `subPath`, `search` and `hash`, and those go through the SAME resolver as an
 * app-scoped `NAVIGATE` (`resolveNavigateRequest`): the hostile filter (schemes,
 * protocol-relative, backslashes, encoded separators, control characters), the structural
 * dot-segment rule and app containment. So `..`, `%2e%2e`, `//evil.com` and `javascript:`
 * cannot produce a URL outside `/apps/run/<slug>/`. No host-owned pair (`from`, `sl`, `src`)
 * is ever carried: they are stripped from the built URL (`stripHostOwnedRunParams`), so an app
 * cannot plant host attribution in a link someone else opens.
 *
 * Shape rules on top of NAVIGATE's, so each field means one thing: `subPath` carries no `?`
 * or `#`; `search` is `''` or starts with `?` and carries no `#`; `hash` is `''` or starts
 * with `#`. Each is capped at {@link SHARE_LINK_MAX_FIELD_LENGTH}.
 *
 * `shareable` is the surface's `BLOCK_HOST_SHARE_LINK` entry: `false` (the dev tunnel, whose
 * slug is a block id) refuses like a surface with no app route.
 *
 * Every refusal REPLIES (`kind: 'refuse'`) so the block's request settles. Only a payload
 * with no usable `requestId` is dropped: there is nothing to reply to.
 */
export function resolveShareLinkRequest(
  raw: unknown,
  opts: {
    base: string | null;
    slug: string;
    origin: string;
    ready: boolean;
    reviewMode: boolean;
    shareable: boolean;
  }
): ShareLinkDecision {
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  const requestId = obj.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return { kind: 'drop' };
  const refuse = (error: string): ShareLinkDecision => ({ kind: 'refuse', requestId, error });

  if (opts.reviewMode || opts.base == null || !opts.shareable) {
    return refuse(SHARE_LINK_UNAVAILABLE_ERROR);
  }
  if (!opts.ready) return refuse(SHARE_LINK_NOT_READY_ERROR);

  const subPath = optionalString(obj.subPath) ?? (obj.subPath === undefined ? '' : null);
  const search = optionalString(obj.search) ?? (obj.search === undefined ? '' : null);
  const hash = optionalString(obj.hash) ?? (obj.hash === undefined ? '' : null);
  if (subPath === null || search === null || hash === null) return refuse(SHARE_LINK_INVALID_ERROR);

  if (
    subPath.length > SHARE_LINK_MAX_FIELD_LENGTH ||
    search.length > SHARE_LINK_MAX_FIELD_LENGTH ||
    hash.length > SHARE_LINK_MAX_FIELD_LENGTH
  ) {
    return refuse(SHARE_LINK_INVALID_ERROR);
  }
  if (/[?#]/.test(subPath)) return refuse(SHARE_LINK_INVALID_ERROR);
  if (search !== '' && (!search.startsWith('?') || search.includes('#'))) {
    return refuse(SHARE_LINK_INVALID_ERROR);
  }
  if (hash !== '' && !hash.startsWith('#')) return refuse(SHARE_LINK_INVALID_ERROR);

  const req = resolveNavigateRequest(
    { path: `${subPath}${search}${hash}` },
    { base: opts.base, slug: opts.slug, siteNavigation: false }
  );
  if (!req || req.scope !== 'app') return refuse(SHARE_LINK_INVALID_ERROR);
  return { kind: 'ok', requestId, url: `${opts.origin}${stripHostOwnedRunParams(req.href)}` };
}

/**
 * What {@link performShareLink} needs from the browser, injected so the decision is
 * testable. `userActivation` is `navigator.userActivation?.isActive`, or `null` when the
 * browser has no such API (then the attempt is made and the browser decides).
 * `frameHasFocus` is `document.activeElement === <the block's iframe>`.
 */
export type ShareLinkEnv = {
  userActivation: boolean | null;
  frameHasFocus: boolean;
  coarsePointer: boolean;
  clipboardWriteText?: (text: string) => Promise<void>;
  share?: (data: { url: string }) => Promise<void>;
  canShare?: (data: { url: string }) => boolean;
};

/**
 * Copy the URL, or open the native share sheet on a touch device, and report what really
 * happened.
 *
 * 🔴 `copied: true` ONLY INSIDE THE RESOLVE BRANCH OF THE CLIPBOARD WRITE. A rejected or
 * throwing write, a missing API, a cancelled share sheet and a refused gesture are all
 * `{ copied: false, method: 'none' }`, so the app shows the URL as selectable text.
 *
 * 🔴 THE WRITE (OR SHARE) IS ISSUED SYNCHRONOUSLY, before this function returns. Both
 * APIs need TRANSIENT user activation, which reaches this frame from a click inside the
 * block's iframe but expires, so it must be consumed synchronously: anything that yields
 * first (`await`, `setTimeout`) can lose it.
 *
 * Without activation (`userActivation === false`) neither API is touched: the app gets the
 * URL and `method: 'none'`, so an app cannot pop a share sheet or write the clipboard on
 * its own.
 *
 * 🔴 ACTIVATION IS PAGE-WIDE, SO THE FRAME MUST ALSO HAVE FOCUS. `userActivation` says only
 * that SOMETHING on the page was just clicked — a click on the host's own chrome counts too —
 * so an app could fire a SHARE_LINK in the window after the viewer clicked a host button.
 * Requiring `frameHasFocus` (the measured state after a click inside the frame: the parent's
 * `activeElement` is the IFRAME) ties the copy to a click inside THIS app. Without it,
 * neither API is touched and the reply is `method: 'none'`.
 */
export function performShareLink(url: string, env: ShareLinkEnv): Promise<ShareLinkResult> {
  const none: ShareLinkResult = { url, copied: false, method: 'none' };
  if (env.userActivation === false || !env.frameHasFocus) return Promise.resolve(none);

  const data = { url };
  // Inside the try: a throwing canShare must resolve to `none`, never throw synchronously,
  // or the host's `.then` never settles the per-block limiter.
  try {
    const useShare =
      env.coarsePointer &&
      typeof env.share === 'function' &&
      (typeof env.canShare !== 'function' || env.canShare(data));
    if (useShare && env.share) {
      return env.share(data).then(
        (): ShareLinkResult => ({ url, copied: false, method: 'share' }),
        () => none
      );
    }
    if (typeof env.clipboardWriteText === 'function') {
      return env.clipboardWriteText(url).then(
        (): ShareLinkResult => ({ url, copied: true, method: 'clipboard' }),
        () => none
      );
    }
  } catch {
    return Promise.resolve(none);
  }
  return Promise.resolve(none);
}

/** Minimum gap between two admitted SHARE_LINKs from one block instance. */
export const SHARE_LINK_MIN_INTERVAL_MS = 1000;

/**
 * One SHARE_LINK in flight per block instance, and at most one per
 * {@link SHARE_LINK_MIN_INTERVAL_MS}. A refused request is answered with
 * {@link SHARE_LINK_RATE_LIMITED_ERROR}, never queued: a queued share would fire later,
 * outside the click that asked for it.
 */
export function createShareLinkLimiter(now: () => number = Date.now) {
  let inFlight = false;
  let last = Number.NEGATIVE_INFINITY;
  return {
    admit(): boolean {
      const t = now();
      if (inFlight || t - last < SHARE_LINK_MIN_INTERVAL_MS) return false;
      inFlight = true;
      last = t;
      return true;
    },
    settle(): void {
      inFlight = false;
    },
  };
}

/**
 * `NAVIGATE { replace: true }` asks the host to REPLACE the current history entry instead of
 * pushing one (for example, switching the take shown on one character). Only the literal
 * `true` counts. It applies to app-scoped, same-tab navigation only.
 */
export function navigateWantsReplace(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { replace?: unknown }).replace === true;
}
