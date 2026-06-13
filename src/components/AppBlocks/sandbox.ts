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
