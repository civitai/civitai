import { describe, expect, it, vi } from 'vitest';

// scope-grant.service imports the Prisma client at module load; mock it so the
// (pure) partitionByConsent / consentGatedScopes helpers run without a real
// Prisma engine (mirrors scope-grant.service.test.ts).
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
  SKIP_OAUTH_CHECK,
} from '~/shared/constants/block-scope.constants';
import {
  consentGatedScopes,
  partitionByConsent,
} from '~/server/services/blocks/scope-grant.service';
import {
  DEV_TOKEN_SCOPE_ALLOWLIST,
  TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
} from '~/server/services/blocks/dev-scoped-mint.service';

/**
 * The #3090 scope-plumbing guard for `collections:read:self` /
 * `collections:write:self`.
 *
 * #3090: a page-app token that declared a CONSENT-GATED scope silently dropped it
 * at mint (the viewer had no grant row) → every op that needed the scope 403'd.
 * The fix is to make the collections scopes CONSENT-EXEMPT, so the mint's
 * `partitionByConsent` puts them in `signable` UNCONDITIONALLY (no grant needed)
 * and the minted token therefore actually CARRIES them end-to-end.
 *
 * This test locks the deterministic mint-time seam (partitionByConsent /
 * consentGatedScopes) rather than the whole HTTP mint path.
 */
describe('collections scopes — registry + #3090 plumbing', () => {
  const READ = 'collections:read:self';
  const WRITE = 'collections:write:self';
  const PRIVATE = 'collections:read:private';

  it('are known, no-OAuth-bit (SKIP_OAUTH_CHECK) registry scopes', () => {
    expect(isKnownBlockScope(READ)).toBe(true);
    expect(isKnownBlockScope(WRITE)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[READ]).toBe(SKIP_OAUTH_CHECK);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[WRITE]).toBe(SKIP_OAUTH_CHECK);
  });

  it('#3090: a token minted with the collections scopes CARRIES them even with NO user grant', () => {
    // Empty grant set = the viewer has consented to nothing. Consent-gated scopes
    // would be WITHHELD (the #3090 failure); consent-exempt scopes must survive.
    const { signable, missing } = partitionByConsent([READ, WRITE], new Set<string>());
    expect(signable).toEqual(expect.arrayContaining([READ, WRITE]));
    expect(missing).toEqual([]);
  });

  it('consentGatedScopes excludes the exempt collections scopes but KEEPS read:private', () => {
    // read:self + write:self are exempt (dropped); buzz:read:self + the
    // consent-GATED read:private are retained in the "requires a grant" set.
    const gated = consentGatedScopes([READ, WRITE, PRIVATE, 'buzz:read:self']);
    expect(gated).toContain('buzz:read:self');
    expect(gated).toContain(PRIVATE);
    expect(gated).not.toContain(READ);
    expect(gated).not.toContain(WRITE);
  });

  it('read:private is a known SKIP_OAUTH_CHECK scope but is CONSENT-GATED (not exempt)', () => {
    expect(isKnownBlockScope(PRIVATE)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[PRIVATE]).toBe(SKIP_OAUTH_CHECK);
    // With NO grant, read:private is WITHHELD (unlike the exempt read:self/write:self).
    const { signable, missing } = partitionByConsent([READ, PRIVATE], new Set<string>());
    expect(signable).toContain(READ); // exempt → always signable
    expect(signable).not.toContain(PRIVATE); // gated → withheld without a grant
    expect(missing).toEqual([PRIVATE]);
  });

  it('read:private mints ONCE the user has granted it', () => {
    const { signable, missing } = partitionByConsent(
      [READ, PRIVATE],
      new Set<string>([PRIVATE])
    );
    expect(signable).toEqual(expect.arrayContaining([READ, PRIVATE]));
    expect(missing).toEqual([]);
  });

  it('are included in BOTH dev-mint allowlists (dev:live + dev-tunnel can exercise them)', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(READ)).toBe(true);
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(WRITE)).toBe(true);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has(READ)).toBe(true);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has(WRITE)).toBe(true);
    // social:tip:self stays OUT of the dev allowlists (real money).
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
  });
});
