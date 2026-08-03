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

// Auto-injected for trusted publishers. Unverified blocks still get an
// opaque origin; verified/internal blocks need their real origin so the
// host's explicit-targetOrigin postMessage + host-side origin allowlist
// work as designed.
export const TRUSTED_TIERS: ReadonlySet<string> = new Set(['internal', 'verified']);

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
 * `allow-same-origin` is added only for trusted (internal/verified) tiers.
 */
export function intersectSandbox(raw: string | undefined, trustTier: string): string {
  const declared = (raw ?? '').split(/\s+/).filter((t) => ALLOWED_SANDBOX_TOKENS.has(t));
  const tokens = new Set<string>(MINIMAL_SANDBOX);
  for (const t of declared) tokens.add(t);
  if (TRUSTED_TIERS.has(trustTier)) tokens.add('allow-same-origin');
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
 * NEVER added — the review host forces `trustTier:'unverified'` (opaque origin).
 */
export const REVIEW_SANDBOX_ALLOWED_TOKENS: ReadonlySet<string> = new Set<string>([
  'allow-scripts',
  'allow-forms',
]);

/**
 * Clamp a manifest-declared sandbox string down to the review render-only set
 * (REVIEW_SANDBOX_ALLOWED_TOKENS ∪ the minimal floor). The output is passed to the
 * review host, which runs it through `intersectSandbox(…, 'unverified')` again —
 * so `allow-same-origin` is never added and the opaque origin is preserved. Fails
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
 * `intersectSandbox(sandbox, trustTier)` result) so the transport mode can
 * never drift from the actual frame origin. Internal/verified tiers keep
 * `allow-same-origin` → real origin → returns false → pinned behavior is
 * preserved byte-for-byte.
 */
export function effectiveSandboxIsOpaque(effectiveSandbox: string): boolean {
  return !effectiveSandbox.split(/\s+/).includes('allow-same-origin');
}
