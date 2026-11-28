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
  /**
   * The roots whose one-label subdomains hold app frames: the apps domain (published
   * apps and dev tunnels) and the App Assistant preview domain. A root that is not a
   * dotted name, or that is the embedding host or one of its parents, is ignored.
   */
  domains: readonly string[];
  /** The embedding page's own host. A frame on it, or under it, never gets a real origin. */
  embedderHost: string;
  /** The viewer's `appBlocksSameOriginFrames` flag. Unverified frames need it. */
  unverifiedEnabled: boolean;
};

/** The DNS label prefix of moderator review hosts (`review-<sha16>.<apps domain>`). */
export const REVIEW_HOST_LABEL_PREFIX = 'review-';

function normaliseRoot(root: string): string {
  return root
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
}

/**
 * Is `src` on an app-frame host: `https:`, no port, no credentials, and a hostname
 * that is exactly ONE label under one of `policy.domains`, not a review host, and not
 * the embedding host or a parent of it. Pure, no DOM. A root equal to the embedding
 * host or a parent of it (e.g. a misconfigured `civitai.com`) is dropped, because a
 * real-origin frame under the embedder's own site reads its domain cookies.
 */
export function isAppFrameHost(src: string | undefined, policy: AppFrameOriginPolicy): boolean {
  if (!src) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const embedder = normaliseRoot(policy.embedderHost.split(':')[0] ?? '');
  if (!embedder || host === embedder || embedder.endsWith(`.${host}`)) return false;
  for (const raw of policy.domains) {
    const root = normaliseRoot(raw);
    if (!root.includes('.')) continue;
    if (embedder === root || embedder.endsWith(`.${root}`)) continue;
    const suffix = `.${root}`;
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, -suffix.length);
    if (!label || label.includes('.')) continue;
    if (label.startsWith(REVIEW_HOST_LABEL_PREFIX)) continue;
    return true;
  }
  return false;
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
 *  - `unverified`: only with the viewer flag on and `src` on an app-frame host.
 *  - `verified` / `internal`: only on an app-frame host; the flag is not read.
 */
export function mayGrantSameOrigin(args: {
  src: string | undefined;
  trustTier: string;
  reviewMode?: boolean;
  policy: AppFrameOriginPolicy | null;
}): boolean {
  const { src, trustTier, reviewMode, policy } = args;
  const trusted = TRUSTED_TIERS.has(trustTier);
  if (policy === null) return trusted;
  if (reviewMode) return false;
  if (trusted) return isAppFrameHost(src, policy);
  return policy.unverifiedEnabled && isAppFrameHost(src, policy);
}

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
  frame?: { src: string | undefined; reviewMode?: boolean; policy: AppFrameOriginPolicy | null }
): string {
  const declared = (raw ?? '').split(/\s+/).filter((t) => ALLOWED_SANDBOX_TOKENS.has(t));
  const tokens = new Set<string>(MINIMAL_SANDBOX);
  for (const t of declared) tokens.add(t);
  const grant = mayGrantSameOrigin({
    src: frame?.src,
    trustTier,
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
