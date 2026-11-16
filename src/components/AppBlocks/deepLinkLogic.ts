import { withRunLaunchOrigin } from '~/shared/utils/apps-run-origin';
import { resolveNavigateRequest } from './pageBlockHostLogic';

/**
 * Deep links into app state (HQ app_blocks_sdk_j1gc): the pure rules behind
 *
 *  - the `search` / `hash` the page host forwards to its block in
 *    `BLOCK_INIT.context` and `ROUTE_CHANGED` ({@link resolveBridgeLocation});
 *  - the `SHARE_LINK` bridge: the canonical URL ({@link resolveShareLinkRequest}),
 *    the copy or share itself ({@link performShareLink}), and its rate limit
 *    ({@link createShareLinkLimiter});
 *  - `NAVIGATE`'s `replace` flag ({@link navigateWantsReplace}).
 *
 * `PageBlockHost` owns the wiring; everything here is pure so it can be unit-tested
 * (`__tests__/deepLinkLogic.test.ts`).
 */

/**
 * Longest `search`, `hash` or share `subPath` that crosses the bridge. Longer is DROPPED
 * (forwarded as `''`, or refused for a share), never truncated: a truncated query is a
 * different, wrong query that the app would route on.
 */
export const BRIDGE_LOCATION_MAX_LENGTH = 2048;

const LOCATION_SENTINEL_ORIGIN = 'https://page-block-host.invalid';

/**
 * The `search` and `hash` of the host URL, as the block should see them.
 *
 * - Read from `router.asPath`, which is what the address bar shows, through the WHATWG
 *   parser, so control characters arrive percent-encoded, never raw.
 * - The host-owned launch-origin pair (`from`, any spelling) is removed: the block never
 *   wrote it and must not be able to round-trip it (`withRunLaunchOrigin` is the one
 *   implementation of "which pairs are `from`"). Every other pair keeps its bytes and order.
 * - `search` is `''` or starts with `?`; `hash` is `''` or starts with `#`. Each is `''`
 *   when longer than {@link BRIDGE_LOCATION_MAX_LENGTH}.
 *
 * These are separate fields from `subPath` (which still comes from `router.query.path`), so
 * nothing in them can change the slug or the path prefix the block sees.
 */
export function resolveBridgeLocation(asPath: string): { search: string; hash: string } {
  let url: URL;
  try {
    url = new URL(withRunLaunchOrigin(asPath, 'store'), LOCATION_SENTINEL_ORIGIN);
  } catch {
    return { search: '', hash: '' };
  }
  const search = url.search.length > BRIDGE_LOCATION_MAX_LENGTH ? '' : url.search;
  const hash = url.hash.length > BRIDGE_LOCATION_MAX_LENGTH ? '' : url.hash;
  return { search, hash };
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
 * cannot produce a URL outside `/apps/run/<slug>/`. The launch-origin `from` pair is never
 * carried (`launchOrigin` is left at its `'store'` default, which drops every `from`).
 *
 * Shape rules on top of NAVIGATE's, so each field means one thing: `subPath` carries no `?`
 * or `#`; `search` is `''` or starts with `?` and carries no `#`; `hash` is `''` or starts
 * with `#`. Each is capped at {@link BRIDGE_LOCATION_MAX_LENGTH}.
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
  }
): ShareLinkDecision {
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  const requestId = obj.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return { kind: 'drop' };
  const refuse = (error: string): ShareLinkDecision => ({ kind: 'refuse', requestId, error });

  if (opts.reviewMode || opts.base == null) return refuse(SHARE_LINK_UNAVAILABLE_ERROR);
  if (!opts.ready) return refuse(SHARE_LINK_NOT_READY_ERROR);

  const subPath = optionalString(obj.subPath) ?? (obj.subPath === undefined ? '' : null);
  const search = optionalString(obj.search) ?? (obj.search === undefined ? '' : null);
  const hash = optionalString(obj.hash) ?? (obj.hash === undefined ? '' : null);
  if (subPath === null || search === null || hash === null) return refuse(SHARE_LINK_INVALID_ERROR);

  if (
    subPath.length > BRIDGE_LOCATION_MAX_LENGTH ||
    search.length > BRIDGE_LOCATION_MAX_LENGTH ||
    hash.length > BRIDGE_LOCATION_MAX_LENGTH
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
  return { kind: 'ok', requestId, url: `${opts.origin}${req.href}` };
}

/**
 * What {@link performShareLink} needs from the browser, injected so the decision is
 * testable. `userActivation` is `navigator.userActivation?.isActive`, or `null` when the
 * browser has no such API (then the attempt is made and the browser decides).
 */
export type ShareLinkEnv = {
  userActivation: boolean | null;
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
 * block's iframe but expires; anything that yields first (`await`, `setTimeout`) can lose
 * it. Measured in Chromium 153 and Brave 152 (headless): a click inside a sandboxed
 * cross-origin iframe that posts to the parent leaves the parent with
 * `userActivation.isActive === true`, `document.hasFocus() === true` and
 * `document.activeElement` = the IFRAME, and the parent's `writeText` RESOLVES (the
 * clipboard then held the parent's value). The same post sent 6.5 s after load with no
 * click was refused (`NotAllowedError`). Not measured: Firefox, Safari, a headed window
 * losing OS focus, and `navigator.share` (absent on desktop Linux Chromium).
 *
 * Without activation (`userActivation === false`) neither API is touched: the app gets the
 * URL and `method: 'none'`, so an app cannot pop a share sheet or write the clipboard on
 * its own.
 */
export function performShareLink(url: string, env: ShareLinkEnv): Promise<ShareLinkResult> {
  const none: ShareLinkResult = { url, copied: false, method: 'none' };
  if (env.userActivation === false) return Promise.resolve(none);

  const data = { url };
  const useShare =
    env.coarsePointer &&
    typeof env.share === 'function' &&
    (typeof env.canShare !== 'function' || env.canShare(data));

  try {
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
