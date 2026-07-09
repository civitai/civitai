/**
 * Anonymous-conversion gate for the host's REQUEST_SIGN_IN handler.
 *
 * A block rendered for a logged-out viewer (from the scope-free BLOCK_INIT
 * context) asks the host to start the civitai login flow when the user clicks
 * an action that needs auth/money (e.g. Generate). usePostMessage already pins
 * origin + event.source; this pure predicate centralises the two remaining
 * host-side conditions so they can be unit-tested without driving the full
 * iframe postMessage harness (same pattern as resolveBuzzPurchaseRequest):
 *
 *   1. status === 'ready' — only honor the request once BLOCK_READY has landed,
 *      so a pre-handshake block can't pop a login popup before any interaction.
 *   2. returnUrl sanitisation — a block-supplied returnUrl is honored ONLY when
 *      it is an in-app, same-origin path (begins with a single '/'). Absolute
 *      URLs and protocol-relative ('//evil.com') values are dropped so a block
 *      can't bounce the user off-site through the post-login redirect; the
 *      caller then defaults returnUrl to the current page.
 *
 * Returns `null` when the request must be ignored (status not ready), or the
 * resolved login intent (`{ returnUrl?: string }`) when the login popup should open.
 */
import type { HostStatus } from './openBuzzPurchaseGate';

export interface ResolvedSignInRequest {
  /** Sanitised same-origin return path, or undefined to let the modal default. */
  returnUrl?: string;
}

/** A block-supplied returnUrl is safe only if it is a same-origin in-app path. */
export function isSafeReturnUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    // reject protocol-relative '//evil.com' (which new URL() treats as absolute)
    !value.startsWith('//')
  );
}

export function resolveRequestSignIn(
  status: HostStatus,
  raw: { returnUrl?: unknown } | undefined | null
): ResolvedSignInRequest | null {
  if (status !== 'ready') return null;
  const candidate = raw && typeof raw === 'object' ? raw.returnUrl : undefined;
  return isSafeReturnUrl(candidate) ? { returnUrl: candidate } : {};
}
