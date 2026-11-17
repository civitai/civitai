import { describe, it, expect } from 'vitest';
import { TokenScope, ALL_SCOPES } from '@civitai/auth/token-scope';

import { hasScope, isScopeGrantable, scopeToString, stringToScope, scopeLabels } from '../scope';

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
const CLI_ALLOWED_AFTER = 100777985n;

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
      'Manage your Apps: submit versions, pull source, test locally, edit listings, view analytics and respond to user feedback',
      'Open on-site dev tunnels',
    ]);
  });

  it('does NOT render those labels for the pre-fix mask (negative control)', () => {
    // Without this, a `scopeLabels` that returned every label unconditionally would
    // satisfy the assertions above.
    const before = 100663297n; // UserRead|AppBlocksSubmit|AppBlocksDevTunnel
    expect(scopeLabels(before)).toEqual([
      'Read profile, settings & email',
      'Manage your Apps: submit versions, pull source, test locally, edit listings, view analytics and respond to user feedback',
      'Open on-site dev tunnels',
    ]);
  });

  it('renders nothing for the empty mask', () => {
    expect(scopeLabels(0n)).toEqual([]);
  });

  it('never renders a blank string for a bit it claims to cover', () => {
    // A missing `tokenScopeLabels` entry would show the user an empty bullet on the
    // consent screen rather than failing loudly.
    for (const label of scopeLabels(ALL_SCOPES)) {
      expect(label.length).toBeGreaterThan(0);
    }
    // Positive control on the loop above — it must have iterated.
    expect(scopeLabels(ALL_SCOPES).length).toBeGreaterThanOrEqual(28);
  });

  it('renders the Apps consent labels for bits 31 and 32', () => {
    expect(scopeLabels(2147483648n)).toEqual(['See the Apps available to you']);
    expect(scopeLabels(4294967296n)).toEqual(['See your own data in Apps']);
    expect(scopeLabels(6442450945n)).toEqual([
      'Read profile, settings & email',
      'See the Apps available to you',
      'See your own data in Apps',
    ]);
  });

  it('renders the Civitai Link pairing label for bit 27', () => {
    expect(scopeLabels(TokenScope.LinkConnect)).toEqual([
      'Connect the Civitai Link app to your account',
    ]);
  });

  it('renders every label for the civitai-link-desktop consent screen, in bit order', () => {
    // UserRead|VaultRead|VaultWrite|LinkConnect — the mask the desktop client requests.
    expect(scopeLabels(159383553n)).toEqual([
      'Read profile, settings & email',
      'View vault',
      'Manage vault',
      'Connect the Civitai Link app to your account',
    ]);
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
    expect(stringToScope(String(ALL_SCOPES + 1n))).toBe(0n); // out of range → deny
    expect(stringToScope('-1')).toBe(0n);
    expect(stringToScope('not-a-number')).toBe(0n);
    expect(stringToScope(undefined)).toBe(0n);
  });

  it('decodes a mask carrying bits 31 and 32 without truncating it to 32 bits', () => {
    // UserRead | AppsRead | AppDataRead. A 32-bit decode (parseInt + a number bound of 2^31 - 1)
    // refused this as out of range.
    expect(stringToScope('6442450945')).toBe(6442450945n);
    expect(scopeToString(6442450945n)).toEqual(['6442450945']);
    expect(stringToScope('8589934592')).toBe(0n); // bit 33: no such scope → deny
  });

  it('accepts the Civitai Link desktop mask, which exceeds Full', () => {
    // RED before the bit exists: 159383553 > the old ALL_SCOPES (134217727), so the
    // out-of-range clamp returned 0 and the hub would answer invalid_scope.
    expect(stringToScope('159383553')).toBe(159383553n);
    expect(scopeToString(159383553n)).toEqual(['159383553']);
  });
});

describe('isScopeGrantable', () => {
  const CATALOG = TokenScope.AppStoreCatalogWrite;
  const CEILING = TokenScope.UserRead | TokenScope.AIServicesWrite | CATALOG;

  it('lets client_credentials mint the catalog bit (UserRead included) within the ceiling', () => {
    expect(isScopeGrantable(CEILING, CATALOG, 'client_credentials')).toBe(true);
    expect(isScopeGrantable(CEILING, CATALOG | TokenScope.UserRead, 'client_credentials')).toBe(
      true
    );
  });

  it('caps client_credentials at UserRead|AppStoreCatalogWrite even inside the ceiling', () => {
    expect(isScopeGrantable(CEILING, TokenScope.AIServicesWrite, 'client_credentials')).toBe(false);
    expect(
      isScopeGrantable(CEILING, CATALOG | TokenScope.AIServicesWrite, 'client_credentials')
    ).toBe(false);
  });

  it('keeps the ceiling for client_credentials', () => {
    expect(isScopeGrantable(TokenScope.UserRead, CATALOG, 'client_credentials')).toBe(false);
  });

  it('never lets a user grant carry the catalog bit, even when the ceiling has it', () => {
    expect(isScopeGrantable(CEILING, CATALOG, 'user')).toBe(false);
    expect(isScopeGrantable(CEILING, CATALOG | TokenScope.UserRead, 'user')).toBe(false);
  });

  it('never lets a user or client_credentials grant carry WorkerRegister, even within the ceiling', () => {
    const worker = TokenScope.WorkerRegister;
    expect(isScopeGrantable(CEILING | worker, worker, 'user')).toBe(false);
    expect(isScopeGrantable(CEILING | worker, worker | TokenScope.UserRead, 'user')).toBe(false);
    expect(isScopeGrantable(CEILING | worker, worker, 'client_credentials')).toBe(false);
    expect(isScopeGrantable(CEILING | worker, CATALOG, 'client_credentials')).toBe(true);
  });

  it('lets a user grant carry AppsRead and AppDataRead (bits 31, 32) within the ceiling', () => {
    const apps = 2147483648n | 4294967296n;
    expect(isScopeGrantable(TokenScope.UserRead | apps, apps | TokenScope.UserRead, 'user')).toBe(
      true
    );
    // Outside the ceiling they are refused like any other bit.
    expect(isScopeGrantable(TokenScope.UserRead | 2147483648n, apps, 'user')).toBe(false);
    // They are user scopes: client_credentials may not carry them.
    expect(isScopeGrantable(CEILING | apps, 2147483648n, 'client_credentials')).toBe(false);
  });

  it('leaves user grants within the ceiling unchanged (positive control)', () => {
    expect(
      isScopeGrantable(CEILING, TokenScope.AIServicesWrite | TokenScope.UserRead, 'user')
    ).toBe(true);
    expect(isScopeGrantable(TokenScope.None, TokenScope.UserRead, 'user')).toBe(true);
    expect(isScopeGrantable(CEILING, TokenScope.VaultRead, 'user')).toBe(false);
  });
});
