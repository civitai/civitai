// Pure render-decision for IframeHost. Extracted so the collapse-on-failure
// contract is unit-testable in the node vitest env (no RTL — civitai-web's
// vitest runs `environment: 'node'` and only collects `*.test.ts`; full
// Mantine component renders aren't available, mirroring the W7/W8 pure-helper
// pattern: sortInstallsForSlot, failureSnapshot, etc.).
//
// Contract (Issue: "failed block must collapse, not show a broken card"):
//   - Every TERMINAL-FAILURE state collapses → 'collapse' (the host renders
//     null; the slot takes no space — no visible broken card, no reserved gap).
//     This covers: malformed manifest (empty src / bad origin), 'timeout'
//     (no BLOCK_READY in 10s), 'fatal' (BLOCK_ERROR{fatal}), and 'no_token'
//     (token never resolved → the old token_error card).
//   - 'loading' keeps the brief skeleton.
//   - 'ready' renders the block inside the W7 trust chrome.
//
// Rendering null on failure shows no content, so the FRAME-1 anti-spoofing
// property is preserved — there is nothing for a block to masquerade as. The
// trust chrome stays on the READY state only.

export type HostStatus = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token';

export type HostRender = 'collapse' | 'loading' | 'ready';

export function hostRenderDecision(args: {
  iframeSrc: string;
  expectedOrigin: string;
  status: HostStatus;
}): HostRender {
  const { iframeSrc, expectedOrigin, status } = args;

  // Malformed manifest (empty iframe.src / unparseable origin) is a terminal
  // failure — collapse instead of mounting an about:blank that times out.
  if (!iframeSrc || !expectedOrigin) return 'collapse';

  // Terminal-failure statuses collapse.
  if (status === 'timeout' || status === 'fatal' || status === 'no_token') {
    return 'collapse';
  }

  // 'loading' shows the skeleton; 'ready' renders the framed block.
  return status === 'ready' ? 'ready' : 'loading';
}
