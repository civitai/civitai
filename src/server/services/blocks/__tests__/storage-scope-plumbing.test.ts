import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  APP_STORAGE_SCOPES,
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
  isSensitiveBlockScope,
  SKIP_OAUTH_CHECK,
} from '~/shared/constants/block-scope.constants';
import {
  APP_STORAGE_PUBLISH_SCOPE,
  APP_STORAGE_BASE_SCOPE,
} from '~/shared/constants/block-storage.constants';
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
 * `apps:storage` + `apps:storage:publish` — the document store's two scopes. The wiring
 * ledger, modelled on `store-items-scope-plumbing.test.ts`: each seam fails silently on its
 * own (an unbound scope 403s every route that requires it, a gated scope with no prompt is
 * stripped at mint, a non-sensitive publish scope ships past review unexplained, one in a
 * mint allowlist reaches a token class the storage routes do not confine).
 */
const BASE = 'apps:storage';
const PUBLISH = 'apps:storage:publish';

describe('storage scopes — registry', () => {
  it('the storage module names the same two strings', () => {
    expect([APP_STORAGE_BASE_SCOPE, APP_STORAGE_PUBLISH_SCOPE]).toEqual([BASE, PUBLISH]);
  });

  it.each([BASE, PUBLISH])('%s is a known scope with no OAuth bit', (scope) => {
    expect(isKnownBlockScope(scope)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[scope]).toBe(SKIP_OAUTH_CHECK);
  });

  it('only the publish scope is sensitive', () => {
    expect(isSensitiveBlockScope(PUBLISH)).toBe(true);
    expect(isSensitiveBlockScope(BASE)).toBe(false);
  });

  // The `auth: "oauth"` refusal keys on this set. `apps:storage` has no trailing colon, so a
  // prefix-only derivation would have left it out.
  it('both are in the auth:"oauth" conflict set', () => {
    expect(APP_STORAGE_SCOPES).toContain(BASE);
    expect(APP_STORAGE_SCOPES).toContain(PUBLISH);
  });

  it('both have a consent description and an analytics label', () => {
    expect(SCOPE_DESCRIPTIONS[BASE]).toBe(
      "Keep your data in this app's own store, and read, mark and count the entries it shares with all its users"
    );
    expect(SCOPE_DESCRIPTIONS[PUBLISH]).toBe(
      "Add and edit entries in this app's shared data as you — every user of the app can read them"
    );
    expect(scopeBucketLabel(BASE)).toBe('App-local storage calls');
    expect(scopeBucketLabel(PUBLISH)).toBe('Shared storage publishes');
  });

  it('only the exempt scope carries a fixed (cannot-be-withdrawn) note', () => {
    expect(FIXED_SCOPE_NOTES[BASE]).toMatch(/^Can't be withdrawn\./);
    expect(Object.hasOwn(FIXED_SCOPE_NOTES, PUBLISH)).toBe(false);
  });
});

describe('storage scopes — consent', () => {
  it('apps:storage is consent-EXEMPT: signable with no grant at all', () => {
    expect(isConsentExemptScope(BASE)).toBe(true);
    expect(consentGatedScopes([BASE])).toEqual([]);
    expect(partitionByConsent([BASE], new Set())).toEqual({ signable: [BASE], missing: [] });
  });

  // What the mint does with an un-consented gated scope: it is left off the token and
  // reported as `missing` for the host to ask about.
  it('apps:storage:publish is consent-GATED: withheld without a grant, signed with one', () => {
    expect(isConsentExemptScope(PUBLISH)).toBe(false);
    expect(consentGatedScopes([BASE, PUBLISH])).toEqual([PUBLISH]);
    expect(partitionByConsent([BASE, PUBLISH], new Set())).toEqual({
      signable: [BASE],
      missing: [PUBLISH],
    });
    expect(partitionByConsent([BASE, PUBLISH], new Set([PUBLISH]))).toEqual({
      signable: [BASE, PUBLISH],
      missing: [],
    });
  });
});

describe('storage scopes — runtime binding', () => {
  const req = {} as never;

  it('apps:storage admits an anonymous subject (shared reads are public within the app)', () => {
    expect(() =>
      enforceContextBinding({ scopes: [BASE], sub: 'anon' } as never, req, BASE)
    ).not.toThrow();
  });

  it('apps:storage:publish accepts a real user subject', () => {
    expect(() =>
      enforceContextBinding({ scopes: [PUBLISH], sub: 'user:42' } as never, req, PUBLISH)
    ).not.toThrow();
  });

  it('apps:storage:publish refuses an anonymous subject, naming the scope', () => {
    expect(() =>
      enforceContextBinding({ scopes: [PUBLISH], sub: 'anon' } as never, req, PUBLISH)
    ).toThrow(`${PUBLISH} requires authenticated subject`);
  });
});

describe('storage scopes — which mints carry them', () => {
  // The bearer dev token carries both: the storage routes confine it to `dev:<uid>`.
  it('DEV_TOKEN_SCOPE_ALLOWLIST admits both, and its clamp keeps both', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(BASE)).toBe(true);
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(PUBLISH)).toBe(true);
    const granted = clampDevScopes({
      scopeSource: [BASE, PUBLISH, 'user:read:self'],
      oauthAllowed: null,
      spendEntitled: false,
      spendRequested: false,
      allowlist: DEV_TOKEN_SCOPE_ALLOWLIST,
    });
    expect(granted).toEqual([BASE, PUBLISH, 'user:read:self']);
  });

  // The run-for-real review mint carries both: the storage routes confine its token to the
  // reviewing moderator's own `rev:<publishRequestId>:<uid>` namespace (`doc-store-access.ts`).
  it('REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST admits both, and its clamp keeps both', () => {
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(BASE)).toBe(true);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(PUBLISH)).toBe(true);
    const granted = clampDevScopes({
      scopeSource: [BASE, PUBLISH, 'user:read:self'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).toEqual([BASE, PUBLISH, 'user:read:self']);
  });

  const WITHHOLDING = {
    TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    REVIEW_MINT_SCOPE_ALLOWLIST,
  };

  // Each allowlist must visibly ADMIT a known scope, so "absent" below is a finding about
  // the set and not about an empty or misnamed object.
  it.each(Object.entries(WITHHOLDING))('%s admits user:read:self but neither scope', (_n, set) => {
    expect(set.has('user:read:self')).toBe(true);
    expect(set.has(BASE)).toBe(false);
    expect(set.has(PUBLISH)).toBe(false);
  });

  it.each(Object.entries(WITHHOLDING))('the %s clamp strips both', (_n, allowlist) => {
    const granted = clampDevScopes({
      scopeSource: [BASE, PUBLISH, 'user:read:self'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist,
    });
    expect(granted).toEqual(['user:read:self']);
  });

  it('the tunnel and private-run mint paths strip both', () => {
    expect(clampTunnelDeclaredScopes([BASE, PUBLISH, 'user:read:self'])).toEqual([
      'user:read:self',
    ]);
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      expect(clampPrivateRunScopes([BASE, PUBLISH, 'user:read:self'], audience)).toEqual([
        'user:read:self',
      ]);
    }
  });
});

describe('storage scopes — the canonical manifest schema', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../public/schemas/app-block/v1.json'),
      'utf8'
    )
  );

  it('both are declarable, publish is listed among the sensitive scopes, in registry order', () => {
    expect(schema.properties.scopes.items.enum).toContain(BASE);
    expect(schema.properties.scopes.items.enum).toContain(PUBLISH);
    expect(schema.properties.scopeJustifications.description).toContain(`\`${PUBLISH}\``);
    expect(schema.properties.scopes.items.enum).toEqual(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
  });

  // The old four stay declarable: their routes stay live until apps migrate.
  it('keeps the four legacy storage scopes', () => {
    for (const scope of [
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]) {
      expect(schema.properties.scopes.items.enum).toContain(scope);
      expect(isKnownBlockScope(scope)).toBe(true);
    }
  });
});
