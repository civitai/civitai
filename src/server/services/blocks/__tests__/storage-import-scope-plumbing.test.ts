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
import {
  SCOPE_DESCRIPTIONS,
  SCOPE_PLAIN_TITLES,
} from '~/server/services/blocks/scope-descriptions.constants';

/**
 * `apps:storage:import` — reach the viewer's documents in ANOTHER app through the imports the
 * manifest declares. The wiring ledger, modelled on `storage-scope-plumbing.test.ts`: a scope
 * that ships consent-exempt reaches every viewer's other-app data with no prompt; one missing
 * from the sensitive set ships past review unexplained; one in the review allowlist would give
 * a reviewer's token a second app's data.
 */
const IMPORT = 'apps:storage:import';
const BASE = 'apps:storage';

describe('apps:storage:import — registry', () => {
  it('is a known scope with no OAuth bit, in the storage family', () => {
    expect(isKnownBlockScope(IMPORT)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[IMPORT]).toBe(SKIP_OAUTH_CHECK);
    expect(APP_STORAGE_SCOPES).toContain(IMPORT);
  });

  it('is sensitive, and has a consent description and a plain title', () => {
    expect(isSensitiveBlockScope(IMPORT)).toBe(true);
    expect(SCOPE_DESCRIPTIONS[IMPORT]?.trim()).toBeTruthy();
    expect(SCOPE_PLAIN_TITLES[IMPORT]?.trim()).toBeTruthy();
  });

  it('is declarable in the canonical schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../../../public/schemas/app-block/v1.json'),
        'utf8'
      )
    );
    expect(schema.properties.scopes.items.enum).toContain(IMPORT);
  });
});

describe('apps:storage:import — consent', () => {
  // An unknown scope is gated too, so this holds before the scope exists; it pins that the scope
  // never joins the exempt set.
  it('INVARIANT GUARD: is consent-GATED: withheld without a grant, signed with one', () => {
    expect(isConsentExemptScope(IMPORT)).toBe(false);
    expect(consentGatedScopes([BASE, IMPORT])).toEqual([IMPORT]);
    expect(partitionByConsent([BASE, IMPORT], new Set())).toEqual({
      signable: [BASE],
      missing: [IMPORT],
    });
    expect(partitionByConsent([BASE, IMPORT], new Set([IMPORT]))).toEqual({
      signable: [BASE, IMPORT],
      missing: [],
    });
  });

  it('refuses an anonymous subject, naming the scope, and admits a real user', () => {
    const req = {} as never;
    expect(() =>
      enforceContextBinding({ scopes: [IMPORT], sub: 'anon' } as never, req, IMPORT)
    ).toThrow(`${IMPORT} requires authenticated subject`);
    expect(() =>
      enforceContextBinding({ scopes: [IMPORT], sub: 'user:42' } as never, req, IMPORT)
    ).not.toThrow();
  });
});

describe('apps:storage:import — which mints carry it', () => {
  // The bearer dev token does not carry it (operator decision D1, 2026-11-02): a development
  // token reaches no other app, and the storage route refuses `?from=` on one as well.
  it('the bearer dev-token clamp strips it and keeps apps:storage', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(IMPORT)).toBe(false);
    expect(
      clampDevScopes({
        scopeSource: [BASE, IMPORT, 'user:read:self'],
        oauthAllowed: null,
        spendEntitled: false,
        spendRequested: false,
        allowlist: DEV_TOKEN_SCOPE_ALLOWLIST,
      })
    ).toEqual([BASE, 'user:read:self']);
  });

  // A review token must never reach a second app's data (the route refuses it too).
  it.each(
    Object.entries({
      REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
      REVIEW_MINT_SCOPE_ALLOWLIST,
      TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    })
  )('INVARIANT GUARD: the %s clamp strips it and keeps user:read:self', (_name, allowlist) => {
    expect(
      clampDevScopes({
        scopeSource: [IMPORT, 'user:read:self'],
        oauthAllowed: null,
        spendEntitled: true,
        spendRequested: true,
        allowlist,
      })
    ).toEqual(['user:read:self']);
  });

  it('INVARIANT GUARD: the tunnel and private-run paths strip it', () => {
    expect(clampTunnelDeclaredScopes([IMPORT, 'user:read:self'])).toEqual(['user:read:self']);
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      expect(clampPrivateRunScopes([IMPORT, 'user:read:self'], audience)).toEqual([
        'user:read:self',
      ]);
    }
  });
});
