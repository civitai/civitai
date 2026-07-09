/**
 * SSR access decision for the "App builders" get-started page
 * (`/apps/get-started`). Pure, React-free, and standalone so the GATING
 * INVARIANT is unit-testable in the node-env unit project without importing the
 * page's React/Mantine module graph. Mirrors `resolveAppsPageAccess`.
 *
 * 🔒 GATING INVARIANT (Scope A — do not violate):
 *   - The `features.appBlocksGetStarted` flag gate is the ONLY access control,
 *     and it's a hard `notFound` (never a session→login redirect). The flag is
 *     STAGED MOD-ONLY today (`['mod']` in feature-flags.service.ts), so it
 *     resolves for moderators only and the page is dark-to-public until the flag
 *     is widened to `['public']`. This resolver does NOT depend on the flag's
 *     availability value — it gates purely on the resolved boolean, so widening
 *     the flag needs no change here.
 *   - INDEPENDENT of the mod-only `appBlocks` gate (`resolveAppsPageAccess`),
 *     which keeps guarding every other `/apps/*` surface.
 */
export type GetStartedAccessResult = { notFound: true } | { props: Record<string, never> };

export function resolveGetStartedAccess(args: {
  features?: { appBlocksGetStarted?: boolean } | undefined;
}): GetStartedAccessResult {
  // Flag gate ONLY, and it's a hard notFound — never a login redirect.
  if (!args.features?.appBlocksGetStarted) return { notFound: true };
  return { props: {} };
}
