import {
  DEV_HOST_LABEL_REGEX,
  PREVIEW_LABEL_SHAPE,
} from '~/shared/constants/app-frame-hosts.constants';

// Client-side iframe sandbox derivation for App Blocks. Kept in its own
// module (no React/Mantine imports) so it can be unit-tested in isolation
// — same pattern as openBuzzPurchaseGate / sortInstallsForSlot.

// H-6: client-side allowlist intersection. The server validator already
// gates sandbox tokens by trust tier, but a future server-side bypass or
// stored-XSS in the manifest column would otherwise let dangerous tokens
// reach the iframe attribute. This is the second wall.
export const ALLOWED_SANDBOX_TOKENS: ReadonlySet<string> = new Set([
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-modals',
  'allow-pointer-lock',
  'allow-downloads',
]);

// Tiers that get `allow-same-origin` without the viewer flag. Their frames run at a
// real origin so the host's explicit-targetOrigin postMessage and its origin
// allowlist work as designed. Every other tier gets a real origin only through
// `mayGrantSameOrigin` with the `appBlocksSameOriginFrames` flag on.
export const TRUSTED_TIERS: ReadonlySet<string> = new Set(['internal', 'verified']);

/**
 * Where a frame may run at a REAL origin. The host page builds this once per mount
 * (`useAppFrameOriginPolicy`) from server config, so the attribute and the
 * transport mode cannot change under a frame that is already loaded.
 */
export type AppFrameOriginPolicy = {
  /** `APPS_DOMAIN`: published apps (`<blockId>.<root>`) and dev tunnels (`dev-<16 hex>.<root>`). */
  appsDomain: string | null;
  /** `APP_ASSISTANT_PREVIEW_DOMAIN`: App Assistant preview session hosts. */
  previewDomain: string | null;
  /** The embedding page's own host. No root on its site is honoured. */
  embedderHost: string;
  /** The viewer's `appBlocksSameOriginFrames` flag. Unverified frames need it. */
  unverifiedEnabled: boolean;
};

/** The DNS label prefix of moderator review hosts (`review-<sha16>.<apps domain>`). */
export const REVIEW_HOST_LABEL_PREFIX = 'review-';

/** A shared-storage scope: cross-user content the app renders (see GATE-2, `shared-content-safety.ts`). */
const SHARED_STORAGE_SCOPE_PREFIX = 'apps:storage:shared:';

function normaliseHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
}

/**
 * A configured root, or `null` when it may not be honoured: not a dotted name, or on the
 * embedding page's own site (the site is approximated as its last two labels, which holds
 * for every Civitai site). A real-origin frame on the embedder's
 * site would be same-site with it and read its domain cookies.
 */
function usableRoot(raw: string | null, embedder: string): string | null {
  if (!raw) return null;
  const root = normaliseHost(raw);
  if (!root.includes('.')) return null;
  const site = embedder.split('.').slice(-2).join('.');
  // (A dotted parent of a two-label site cannot exist, so "a parent of it" needs no check.)
  if (root === site || root.endsWith(`.${site}`)) return null;
  return root;
}

/**
 * What precedes `.<root>` in `host`, or `null` when `host` is not under it. Not checked
 * for being ONE label: every caller compares it against a dot-free shape (a blockId, the
 * anchored dev / preview label patterns), so a deeper or empty prefix never matches.
 */
function labelUnder(host: string, root: string | null): string | null {
  if (!root || !host.endsWith(`.${root}`)) return null;
  return host.slice(0, -(root.length + 1));
}

/**
 * Is `src` THIS app's frame host: `https:`, no port, no credentials, and a hostname that is
 * exactly one label under a usable root, where that label is
 *  - under `appsDomain`: the app's own `blockId` (its published host) or a dev tunnel label;
 *    never a review host;
 *  - under `previewDomain`: an App Assistant preview session label.
 * Tying the published label to the app's own id keeps one app from being framed at another
 * app's origin and reading its storage. Pure, no DOM.
 */
export function isAppFrameHost(
  src: string | undefined,
  appLabel: string | undefined,
  policy: AppFrameOriginPolicy
): boolean {
  if (!src) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  // `URL` has already lowercased the hostname.
  const host = url.hostname;
  const embedder = normaliseHost(policy.embedderHost.split(':')[0] ?? '');
  if (!embedder) return false;
  const appsLabel = labelUnder(host, usableRoot(policy.appsDomain, embedder));
  if (appsLabel !== null) {
    if (appsLabel.startsWith(REVIEW_HOST_LABEL_PREFIX)) return false;
    return (
      DEV_HOST_LABEL_REGEX.test(appsLabel) || (!!appLabel && appsLabel === appLabel.toLowerCase())
    );
  }
  const previewLabel = labelUnder(host, usableRoot(policy.previewDomain, embedder));
  return previewLabel !== null && PREVIEW_LABEL_SHAPE.test(previewLabel);
}

/**
 * THE rule for `allow-same-origin` on an App Block frame. Every host derives its
 * sandbox through `intersectSandbox`, which asks only this.
 *
 *  - With NO policy (no `AppProvider` above the host, or a tab that booted without
 *    server props; in production every server-rendered boot carries one) a
 *    `verified`/`internal` frame keeps the token exactly as before and an unverified
 *    one never gets it. Nothing below applies.
 *  - A review mount (`reviewMode`) never gets it: pending code runs in a moderator's tab.
 *    (The review host also forces `unverified`, so this matters for every tier.)
 *  - `unverified`: only with the viewer flag on, `src` on the app's own frame host, and no
 *    shared-storage scope declared (GATE-2 in `shared-content-safety.ts`: shared content
 *    is contained by the opaque origin until a structural pin exists).
 *  - `verified` / `internal`: only on the app's own frame host; the flag is not read.
 */
export function mayGrantSameOrigin(args: {
  src: string | undefined;
  trustTier: string;
  appLabel?: string;
  scopes?: readonly string[];
  reviewMode?: boolean;
  policy: AppFrameOriginPolicy | null;
}): boolean {
  const { src, trustTier, appLabel, scopes, reviewMode, policy } = args;
  const trusted = TRUSTED_TIERS.has(trustTier);
  if (policy === null) return trusted;
  if (reviewMode) return false;
  if (trusted) return isAppFrameHost(src, appLabel, policy);
  if (!policy.unverifiedEnabled) return false;
  if ((scopes ?? []).some((scope) => scope.startsWith(SHARED_STORAGE_SCOPE_PREFIX))) return false;
  return isAppFrameHost(src, appLabel, policy);
}

/** What a host knows about the frame it is about to render. */
export type AppFrameDescriptor = {
  src: string | undefined;
  /** The app's `blockId`, whose published host is `<blockId>.<APPS_DOMAIN>`. */
  appLabel?: string;
  /** The scopes the manifest declares. */
  scopes?: readonly string[];
  reviewMode?: boolean;
  policy: AppFrameOriginPolicy | null;
};

// Minimal safe sandbox: just enough for a block to execute its own bundle,
// and nothing that widens its reach over the embedding page or the user
// (no allow-forms / allow-popups / allow-modals / allow-pointer-lock /
// allow-downloads, and never allow-same-origin). This is the deliberate
// floor — NOT a default that can accidentally grant more than declared.
export const MINIMAL_SANDBOX: ReadonlyArray<string> = ['allow-scripts'];

/**
 * L-SANDBOX: derive the iframe `sandbox` attribute from the manifest's
 * declared tokens. Fails CLOSED — when the manifest declares no recognized
 * sandbox tokens (empty, missing, or all-unrecognized) the result is the
 * minimal safe set rather than an implicit wider default. The output is the
 * intersection of {declared ∪ minimal} with the allowlist, so it can only
 * ever be as wide as what the manifest explicitly (and validly) declared.
 * `allow-same-origin` is added only when `mayGrantSameOrigin` says so for `frame`.
 * Without `frame` (a server caller), only a trusted tier gets it, as before.
 */
export function intersectSandbox(
  raw: string | undefined,
  trustTier: string,
  frame?: AppFrameDescriptor
): string {
  const declared = (raw ?? '').split(/\s+/).filter((t) => ALLOWED_SANDBOX_TOKENS.has(t));
  const tokens = new Set<string>(MINIMAL_SANDBOX);
  for (const t of declared) tokens.add(t);
  const grant = mayGrantSameOrigin({
    src: frame?.src,
    trustTier,
    appLabel: frame?.appLabel,
    scopes: frame?.scopes,
    reviewMode: frame?.reviewMode,
    policy: frame?.policy ?? null,
  });
  if (grant) tokens.add('allow-same-origin');
  return Array.from(tokens).join(' ');
}

/**
 * MOD REVIEW SANDBOX (#2831): the ONLY sandbox tokens permitted when previewing a
 * PENDING, un-approved block with a moderator's tab. Every capability that can
 * REACH the mod's tab is dropped even if the manifest declares it —
 * `allow-popups` (open a window at the mod), `allow-downloads` (trigger a download
 * to the mod), `allow-modals`, `allow-pointer-lock`. (`allow-top-navigation*` and
 * `allow-popups-to-escape-sandbox` are not in ALLOWED_SANDBOX_TOKENS, so
 * intersectSandbox already strips them.) Only `allow-scripts` (mandatory to render)
 * and `allow-forms` (low-risk to an opaque origin) survive. `allow-same-origin` is
 * NEVER added: the review host forces `trustTier:'unverified'` AND mounts the page
 * host with `reviewMode`, which `mayGrantSameOrigin` refuses whatever the flag says;
 * review hosts (`review-<sha16>`) are also refused by `isAppFrameHost`.
 */
export const REVIEW_SANDBOX_ALLOWED_TOKENS: ReadonlySet<string> = new Set<string>([
  'allow-scripts',
  'allow-forms',
]);

/**
 * Clamp a manifest-declared sandbox string down to the review render-only set
 * (REVIEW_SANDBOX_ALLOWED_TOKENS ∪ the minimal floor). The output is passed to the
 * review host, which runs it through `intersectSandbox(…, 'unverified', { reviewMode })`
 * again, so `allow-same-origin` is never added and the opaque origin is preserved. Fails
 * CLOSED (an empty / all-stripped manifest → the minimal `allow-scripts` floor).
 */
export function clampReviewSandbox(raw: string | undefined): string {
  const declared = (raw ?? '').split(/\s+/).filter((t) => REVIEW_SANDBOX_ALLOWED_TOKENS.has(t));
  const tokens = new Set<string>(MINIMAL_SANDBOX); // always allow-scripts
  for (const t of declared) tokens.add(t);
  return Array.from(tokens).join(' ');
}

/**
 * L-OPAQUE: does the EFFECTIVE iframe sandbox (the same string handed to the
 * `<iframe sandbox=…>` attribute) lack `allow-same-origin`?
 *
 * A sandboxed iframe WITHOUT `allow-same-origin` runs at an opaque origin —
 * `event.origin` is the literal string `'null'` on every message it sends,
 * and a `postMessage` to it only reaches the frame when `targetOrigin` is
 * `'*'` (a real origin throws "target origin … does not match recipient
 * origin 'null'"). The host's postMessage transport must run in opaque mode
 * for such a frame, otherwise BLOCK_READY (inbound) is dropped and BLOCK_INIT
 * (outbound) never arrives — exactly the boot failure for unverified/external
 * blocks.
 *
 * Pass the SAME value used for the iframe attribute (i.e. the
 * `intersectSandbox(...)` result) so the transport mode can never drift from the
 * actual frame origin. A frame `mayGrantSameOrigin` granted (a trusted tier, or an
 * unverified one with the flag on, on an app-frame host) has a real origin, so this
 * returns false and the transport pins its origin.
 */
export function effectiveSandboxIsOpaque(effectiveSandbox: string): boolean {
  return !effectiveSandbox.split(/\s+/).includes('allow-same-origin');
}
