// Pure logic for PageBlockHost (W10 full-page apps). Extracted so the two
// security/UX-load-bearing decisions are unit-testable in the node vitest env
// (no RTL — civitai-web's unit project runs `environment: 'node'` and only
// collects `*.test.ts`). Mirrors the IframeHost `hostRenderDecision` pattern.

export type PageHostStatus =
  | 'loading'
  | 'ready'
  | 'timeout'
  | 'fatal'
  | 'no_token'
  | 'error';

/**
 * #3/#6: the scopes the minted page JWT ACTUALLY carries — the page manifest's
 * declared scopes minus the consent-gated ones the viewer hasn't granted
 * (`missingScopes`, reported by the mint). The server signs exactly this set,
 * so this is what BLOCK_INIT / TOKEN_REFRESH must advertise to the block.
 * Posting `[]` (the old hardcode) lied to the block about its capabilities
 * (a page token carries `apps:storage:*`). Mirrors IframeHost.grantedScopes.
 */
export function grantedPageScopes(
  declaredScopes: string[],
  missingScopes: string[] | undefined
): string[] {
  if (!missingScopes || missingScopes.length === 0) return declaredScopes;
  const withheld = new Set(missingScopes);
  return declaredScopes.filter((s) => !withheld.has(s));
}

export type PageFallbackReason = 'timeout' | 'token_error' | 'fatal_block_error';

/**
 * #4: map a PageBlockHost terminal status to a BlockFallback reason. Unlike the
 * model IframeHost (which collapses to null on failure because a model column
 * can disappear cleanly), a FULL-PAGE surface that collapses is just a blank
 * viewport. So a failed page renders a message INSIDE the trust frame instead.
 * Returns null for the non-terminal (loading / ready) states — those render the
 * iframe, not a fallback.
 *
 * Anti-spoof note: the message is HOST chrome (not the block), so a failed
 * block still can't masquerade as a working page.
 */
export function pageFallbackReason(status: PageHostStatus): PageFallbackReason | null {
  switch (status) {
    case 'loading':
    case 'ready':
      return null;
    case 'fatal':
      return 'fatal_block_error';
    case 'error':
    case 'no_token':
      return 'token_error';
    case 'timeout':
      return 'timeout';
  }
}
