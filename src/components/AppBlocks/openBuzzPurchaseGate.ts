/**
 * M-BUZZMODAL (audit medium / app-exploits-user) — gate for the host's
 * OPEN_BUZZ_PURCHASE handler.
 *
 * A block can post messages the instant its iframe loads — before the
 * BLOCK_READY handshake completes, while the iframe is still
 * visible-but-non-interactive (pointerEvents:none). Without a readiness gate an
 * untrusted block could pre-render and summon the Buy-Buzz spend modal to nag
 * the user before any interaction. This pure predicate centralises the two
 * conditions the handler must satisfy, so it can be unit-tested without driving
 * the full iframe postMessage harness (same pattern as sortInstallsForSlot).
 *
 * Returns the validated requestId when the modal should open, or `null` when it
 * must be ignored (status not ready, or a malformed payload).
 */
export type HostStatus = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token';

export function resolveBuzzPurchaseRequest(
  status: HostStatus,
  raw: { requestId?: unknown } | undefined | null
): string | null {
  // M-BUZZMODAL: only honor OPEN_BUZZ_PURCHASE once BLOCK_READY has landed.
  if (status !== 'ready') return null;
  if (!raw || typeof raw.requestId !== 'string' || raw.requestId.length === 0) return null;
  return raw.requestId;
}
