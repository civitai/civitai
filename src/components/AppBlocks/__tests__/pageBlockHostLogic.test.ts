import { describe, it, expect } from 'vitest';
import {
  grantedPageScopes,
  pageFallbackReason,
  type PageHostStatus,
} from '../pageBlockHostLogic';

/**
 * W10 PageBlockHost pure logic.
 *
 * #3/#6 — grantedPageScopes: the scopes the host advertises in BLOCK_INIT /
 * TOKEN_REFRESH must be the REAL granted set the JWT carries (declared −
 * missing), NOT the old hardcoded `[]`. A page token carries the viewer-scoped
 * ambient `apps:storage:*` scopes; posting `[]` lied to the block.
 *
 * #4 — pageFallbackReason: a full-page surface in a terminal state must render
 * a BlockFallback message (mapped reason), not a blank viewport.
 */

describe('grantedPageScopes (#3/#6 — BLOCK_INIT carries the JWT scopes, not [])', () => {
  it('returns the declared scopes when nothing is withheld (the real JWT scopes — NOT [])', () => {
    const declared = ['apps:storage:read', 'apps:storage:write'];
    expect(grantedPageScopes(declared, [])).toEqual(declared);
    expect(grantedPageScopes(declared, undefined)).toEqual(declared);
    // The regression we're fixing: this must NOT collapse to the old `[]`.
    expect(grantedPageScopes(declared, [])).not.toEqual([]);
  });

  it('strips the consent-withheld scopes from the granted set', () => {
    const declared = ['apps:storage:read', 'apps:storage:write', 'social:read'];
    expect(grantedPageScopes(declared, ['social:read'])).toEqual([
      'apps:storage:read',
      'apps:storage:write',
    ]);
  });

  it('returns [] only when every declared scope is withheld', () => {
    expect(grantedPageScopes(['social:read'], ['social:read'])).toEqual([]);
  });

  it('is a no-op for a missingScopes entry that was never declared', () => {
    const declared = ['apps:storage:read'];
    expect(grantedPageScopes(declared, ['ai:write:budgeted'])).toEqual(declared);
  });
});

describe('pageFallbackReason (#4 — terminal state renders a fallback, not a blank page)', () => {
  it('returns null for the non-terminal states (iframe is rendered, not a fallback)', () => {
    expect(pageFallbackReason('loading')).toBeNull();
    expect(pageFallbackReason('ready')).toBeNull();
  });

  it('maps each terminal state to a BlockFallback reason (so a failed page shows a message)', () => {
    const cases: Array<[PageHostStatus, string]> = [
      ['timeout', 'timeout'],
      ['fatal', 'fatal_block_error'],
      ['no_token', 'token_error'],
      ['error', 'token_error'],
    ];
    for (const [status, reason] of cases) {
      expect(pageFallbackReason(status)).toBe(reason);
    }
  });

  it('never returns null for a terminal failure state (no blank-viewport regression)', () => {
    for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
      expect(pageFallbackReason(status)).not.toBeNull();
    }
  });
});
