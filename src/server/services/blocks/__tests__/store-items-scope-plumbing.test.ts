import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
  isSensitiveBlockScope,
  SKIP_OAUTH_CHECK,
  unjustifiedSensitiveScopes,
} from '~/shared/constants/block-scope.constants';
import {
  consentGatedScopes,
  isConsentExemptScope,
  partitionByConsent,
} from '~/server/services/blocks/scope-grant.service';
import {
  clampDevScopes,
  clampPrivateRunScopes,
  clampTunnelDeclaredScopes,
  DEV_TOKEN_SCOPE_ALLOWLIST,
  REVIEW_MINT_SCOPE_ALLOWLIST,
  REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
  TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { enforceContextBinding } from '~/server/middleware/block-scope.middleware';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { scopeBucketLabel } from '~/components/AppBlocks/analytics-bucket-labels';
import { FIXED_SCOPE_NOTES } from '~/components/Apps/scopeConsentRows';

/**
 * `apps:store:items:write` — the wiring ledger, modelled on `goods-scope-plumbing.test.ts`.
 * Each seam fails silently: an unbound scope 403s every call, a scope neither exempt nor
 * prompted is stripped at mint, a non-sensitive one ships past review unexplained, and one
 * in a dev or review allowlist lets an unapproved app write public store cards.
 */
const SCOPE = 'apps:store:items:write';

describe('store-items scope — registry', () => {
  it('is a known scope with no OAuth bit', () => {
    expect(isKnownBlockScope(SCOPE)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[SCOPE]).toBe(SKIP_OAUTH_CHECK);
  });

  it('is SENSITIVE, so a manifest declaring it must justify it', () => {
    expect(isSensitiveBlockScope(SCOPE)).toBe(true);
    expect(unjustifiedSensitiveScopes({ scopes: [SCOPE] })).toEqual([SCOPE]);
    expect(
      unjustifiedSensitiveScopes({
        scopes: [SCOPE],
        scopeJustifications: { [SCOPE]: 'Authors can list their generators in the store.' },
      })
    ).toEqual([]);
  });

  it('has a consent description, an analytics label and a fixed-scope note', () => {
    expect(SCOPE_DESCRIPTIONS[SCOPE].toLowerCase()).toContain('store');
    expect(scopeBucketLabel(SCOPE)).not.toBe(SCOPE);
    expect(FIXED_SCOPE_NOTES[SCOPE]).toMatch(/can't be withdrawn/i);
  });
});

describe('store-items scope — consent', () => {
  it('is consent-EXEMPT: signable with no grant at all', () => {
    expect(isConsentExemptScope(SCOPE)).toBe(true);
    expect(consentGatedScopes([SCOPE])).not.toContain(SCOPE);
    const { signable, missing } = partitionByConsent([SCOPE], new Set<string>());
    expect(signable).toContain(SCOPE);
    expect(missing).not.toContain(SCOPE);
  });

  it('positive control: a gated scope IS withheld under the same empty grant set', () => {
    const { signable, missing } = partitionByConsent(['posts:write:self'], new Set<string>());
    expect(signable).not.toContain('posts:write:self');
    expect(missing).toContain('posts:write:self');
  });
});

describe('store-items scope — runtime binding', () => {
  const req = {} as never;

  it('accepts a real user subject', () => {
    expect(() =>
      enforceContextBinding({ scopes: [SCOPE], sub: 'user:42' } as never, req, SCOPE)
    ).not.toThrow();
  });

  it('refuses an anonymous subject, naming this scope', () => {
    expect(() =>
      enforceContextBinding({ scopes: [SCOPE], sub: 'anon' } as never, req, SCOPE)
    ).toThrow(`${SCOPE} requires authenticated subject`);
  });

  it('negative control: an unknown sibling scope hits the fail-closed arm instead', () => {
    expect(() =>
      enforceContextBinding(
        { scopes: ['apps:store:items:delete'], sub: 'user:42' } as never,
        req,
        'apps:store:items:delete'
      )
    ).toThrow('unknown scope: apps:store:items:delete');
  });
});

describe('store-items scope — never minted for dev or review tokens', () => {
  const ALLOWLISTS = {
    DEV_TOKEN_SCOPE_ALLOWLIST,
    TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    REVIEW_MINT_SCOPE_ALLOWLIST,
    REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
  };

  // Each allowlist must visibly ADMIT a known scope, so "absent" below is a finding about the
  // set and not about an empty or misnamed object.
  it.each(Object.entries(ALLOWLISTS))('%s admits user:read:self but not the scope', (_n, set) => {
    expect(set.size).toBeGreaterThan(0);
    expect(set.has('user:read:self')).toBe(true);
    expect(set.has(SCOPE)).toBe(false);
  });

  it.each(Object.entries(ALLOWLISTS))('the %s clamp strips it from a mint', (_n, allowlist) => {
    const granted = clampDevScopes({
      scopeSource: [SCOPE, 'user:read:self'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist,
    });
    expect(granted).toContain('user:read:self');
    expect(granted).not.toContain(SCOPE);
  });

  it('the tunnel and private-run mint paths strip it too', () => {
    const tunnel = clampTunnelDeclaredScopes([SCOPE, 'user:read:self']);
    expect(tunnel).toContain('user:read:self');
    expect(tunnel).not.toContain(SCOPE);
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const privateRun = clampPrivateRunScopes([SCOPE, 'user:read:self'], audience);
      expect(privateRun).toContain('user:read:self');
      expect(privateRun).not.toContain(SCOPE);
    }
  });
});

describe('store-items scope — the canonical manifest schema', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../public/schemas/app-block/v1.json'),
      'utf8'
    )
  );

  it('is declarable, listed among the sensitive scopes, and in registry order', () => {
    expect(schema.properties.scopes.items.enum).toContain(SCOPE);
    expect(schema.properties.scopeJustifications.description).toContain(SCOPE);
    expect(schema.properties.scopes.items.enum).toEqual(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
  });
});
