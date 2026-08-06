import { describe, it, expect } from 'vitest';
import { TokenScope, ALL_SCOPES } from '@civitai/auth/token-scope';

import { hasScope, scopeToString, stringToScope, scopeLabels } from '../scope';

/**
 * `apps/auth/src/lib/server/oauth/scope.ts` — the hub's only scope encode/decode +
 * ceiling-test helpers, and the source of the CONSENT SCREEN's permission list.
 *
 * The label half is the user-visible half: `scopeLabels` is what the device-verify
 * and authorize screens render before someone grants a client authority over their
 * account. Widening the `civitai-cli` client to AI-services scopes (issue #3681)
 * adds Buzz-SPENDING authority — `AIServicesWrite` implicitly authorises orchestrator
 * buzz spend — so the strings a user actually sees for bits 14/15/16 are pinned here
 * as literals rather than derived from `tokenScopeLabels` (deriving the expectation
 * from the implementation would leave a silently-blank label green).
 */

/** The `civitai-cli` client's `allowedScopes` after the AI-services widening. */
const CLI_ALLOWED_AFTER = 100777985;

describe('scopeLabels', () => {
  it('renders the AI-services and Buzz labels for bits 14/15/16', () => {
    expect(scopeLabels(TokenScope.AIServicesRead)).toEqual(['View generation & training history']);
    expect(scopeLabels(TokenScope.AIServicesWrite)).toEqual(['Generate, train & scan']);
    expect(scopeLabels(TokenScope.BuzzRead)).toEqual(['View buzz balance & history']);
  });

  it('renders every label for the widened civitai-cli consent screen, in bit order', () => {
    expect(scopeLabels(CLI_ALLOWED_AFTER)).toEqual([
      'Read profile, settings & email',
      'View generation & training history',
      'Generate, train & scan',
      'View buzz balance & history',
      'Submit Apps for review',
      'Open on-site dev tunnels',
    ]);
  });

  it('does NOT render those labels for the pre-fix mask (negative control)', () => {
    // Without this, a `scopeLabels` that returned every label unconditionally would
    // satisfy the assertions above.
    const before = 100663297; // UserRead|AppBlocksSubmit|AppBlocksDevTunnel
    expect(scopeLabels(before)).toEqual([
      'Read profile, settings & email',
      'Submit Apps for review',
      'Open on-site dev tunnels',
    ]);
  });

  it('renders nothing for the empty mask', () => {
    expect(scopeLabels(0)).toEqual([]);
  });

  it('never renders a blank string for a bit it claims to cover', () => {
    // A missing `tokenScopeLabels` entry would show the user an empty bullet on the
    // consent screen rather than failing loudly.
    for (const label of scopeLabels(ALL_SCOPES)) {
      expect(label.length).toBeGreaterThan(0);
    }
    // Positive control on the loop above — it must have iterated.
    expect(scopeLabels(ALL_SCOPES).length).toBeGreaterThanOrEqual(27);
  });
});

describe('hasScope', () => {
  it('is a SUBSET test against the ceiling, not an intersection test', () => {
    const ceiling = CLI_ALLOWED_AFTER | TokenScope.UserRead;
    expect(hasScope(ceiling, TokenScope.AIServicesWrite)).toBe(true);
    expect(hasScope(ceiling, TokenScope.AIServicesRead | TokenScope.BuzzRead)).toBe(true);
    // Partially-overlapping request: one granted bit + one ungranted bit must be
    // REJECTED as a whole. This is the all-or-nothing property the device flow
    // depends on (and why a client's grant must be widened before the CLI asks).
    expect(hasScope(ceiling, TokenScope.AIServicesRead | TokenScope.VaultRead)).toBe(false);
    expect(hasScope(ceiling, TokenScope.Full)).toBe(false);
  });
});

describe('stringToScope / scopeToString', () => {
  it('round-trips a mask through the library string form', () => {
    expect(scopeToString(CLI_ALLOWED_AFTER)).toEqual(['100777985']);
    expect(stringToScope(scopeToString(CLI_ALLOWED_AFTER))).toBe(CLI_ALLOWED_AFTER);
    expect(stringToScope('100777985')).toBe(CLI_ALLOWED_AFTER);
  });

  it('bounds against ALL_SCOPES, not Full — an opt-in bit survives decoding', () => {
    // Clamping to `Full` (33554431) would silently drop bits 25/26 here.
    expect(CLI_ALLOWED_AFTER).toBeGreaterThan(TokenScope.Full);
    expect(stringToScope(String(ALL_SCOPES))).toBe(ALL_SCOPES);
    expect(stringToScope(String(ALL_SCOPES + 1))).toBe(0); // out of range → deny
    expect(stringToScope('-1')).toBe(0);
    expect(stringToScope('not-a-number')).toBe(0);
    expect(stringToScope(undefined)).toBe(0);
  });
});
