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

  it('consentGatedScopes excludes the collections scopes (they are exempt)', () => {
    // A consent-gated scope (buzz:read:self) is retained; the exempt collections
    // scopes are dropped from the "requires a grant" set.
    const gated = consentGatedScopes([READ, WRITE, 'buzz:read:self']);
    expect(gated).toContain('buzz:read:self');
    expect(gated).not.toContain(READ);
    expect(gated).not.toContain(WRITE);
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
