/**
 * Lazy-consent gate for the host's REQUEST_CONSENT handler.
 *
 * A block rendered for a LOGGED-IN viewer whose block token is missing a
 * consent-gated scope (e.g. `ai:write:budgeted` / `buzz:read:self` withheld at
 * mint because the viewer hasn't granted them yet) asks the host to open its
 * consent UI when the user clicks an action that needs that capability (e.g.
 * Generate) — instead of prompting on load. usePostMessage already pins origin
 * + event.source; this pure predicate centralises the two remaining host-side
 * conditions so they can be unit-tested without the full iframe postMessage
 * harness (same pattern as resolveRequestSignIn / resolveBuzzPurchaseRequest):
 *
 *   1. status === 'ready' — only honor the request once BLOCK_READY has landed,
 *      so a pre-handshake block can't pop a consent modal before any interaction.
 *   2. missingScopes non-empty — nothing to consent to otherwise (the viewer has
 *      already granted everything the app's approved manifest declares), so the
 *      request is a no-op and dropped.
 *
 * The block MAY send an advisory `scopes` hint, but it is deliberately IGNORED:
 * the host grants the missing set it computed at mint (server-known truth), so a
 * block can't widen the grant beyond what was actually withheld. (grantScopes is
 * itself bounded server-side to manifest∩approved, so this is defense-in-depth.)
 *
 * Returns `null` when the request must be ignored (status not ready, or nothing
 * missing), or the scopes to grant when the consent modal should open.
 */
import type { HostStatus } from './openBuzzPurchaseGate';

export function resolveRequestConsent(
  status: HostStatus,
  missingScopes: string[]
): string[] | null {
  if (status !== 'ready') return null;
  if (!Array.isArray(missingScopes) || missingScopes.length === 0) return null;
  return missingScopes;
}
