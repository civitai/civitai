import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  deriveOauthBitmaskFromBlockScopes,
  isKnownBlockScope,
  isSensitiveBlockScope,
  SKIP_OAUTH_CHECK,
  unjustifiedSensitiveScopes,
} from '~/shared/constants/block-scope.constants';
import {
  consentGatedScopes,
  partitionByConsent,
} from '~/server/services/blocks/scope-grant.service';
import {
  DEV_TOKEN_SCOPE_ALLOWLIST,
  PRIVATE_RUN_MINT_SCOPE_ALLOWLIST,
  REVIEW_MINT_SCOPE_ALLOWLIST,
  REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
  TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { enforceContextBinding } from '~/server/middleware/block-scope.middleware';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { scopeBucketLabel } from '~/components/AppBlocks/analytics-bucket-labels';
import { describeBlockAction } from '~/shared/constants/block-action-detail';
import { APP_REACTION_SCOPE } from '~/shared/constants/block-reaction.constants';

/**
 * `social:react:self` — the wiring ledger, modelled on `posts-write-scope-plumbing.test.ts`.
 * Every seam here fails silently: a missing middleware case 403s a route, a scope neither
 * exempt nor prompted is stripped at mint, a non-sensitive one ships past review unexplained,
 * a missing description shows the viewer a raw id, and a review allowlist entry would make a
 * moderator react under their own name for an unapproved app.
 */

const SCOPE = APP_REACTION_SCOPE;

describe('social:react:self — registry', () => {
  it('is a known scope with NO OAuth bit, so approve derives no SocialWrite onto the client', () => {
    expect(SCOPE).toBe('social:react:self');
    expect(isKnownBlockScope(SCOPE)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[SCOPE]).toBe(SKIP_OAUTH_CHECK);
    // The consequence that decided it: an app declaring only this scope gets a zero bitmask.
    expect(deriveOauthBitmaskFromBlockScopes([SCOPE])).toBe(0);
  });

  it('is SENSITIVE, so a manifest declaring it must justify it', () => {
    expect(isSensitiveBlockScope(SCOPE)).toBe(true);
    expect(unjustifiedSensitiveScopes({ scopes: [SCOPE] })).toEqual([SCOPE]);
    expect(
      unjustifiedSensitiveScopes({
        scopes: [SCOPE],
        scopeJustifications: { [SCOPE]: 'Lets viewers like images in the gallery.' },
      })
    ).toEqual([]);
  });

  it('the consent description is pinned whole — it is the only consent the viewer gets', () => {
    expect(SCOPE_DESCRIPTIONS[SCOPE]).toBe(
      'React to images this app shows you, as you — reactions appear on Civitai like your own, without asking each time'
    );
  });

  it('renders human labels in analytics and in the Activity feed', () => {
    expect(scopeBucketLabel(SCOPE)).not.toBe(SCOPE);
    expect(
      describeBlockAction({
        action: 'reaction.set',
        entityType: 'Image',
        entityId: 1,
        reaction: 'Heart',
        reacted: true,
      })
    ).toBe('Added a Heart reaction on this image');
    expect(
      describeBlockAction({
        action: 'reaction.set',
        entityType: 'Image',
        entityId: 1,
        reaction: 'Heart',
        reacted: false,
      })
    ).toBe('Removed a Heart reaction on this image');
  });
});

describe('social:react:self — CONSENT-GATED, not exempt', () => {
  it('is withheld until granted, and a grant for another scope does not unlock it', () => {
    expect(consentGatedScopes([SCOPE])).toContain(SCOPE);
    expect(partitionByConsent([SCOPE], new Set<string>())).toEqual({
      signable: [],
      missing: [SCOPE],
    });
    expect(partitionByConsent([SCOPE], new Set(['posts:write:self']))).toEqual({
      signable: [],
      missing: [SCOPE],
    });
    expect(partitionByConsent([SCOPE], new Set([SCOPE]))).toEqual({
      signable: [SCOPE],
      missing: [],
    });
  });
});

describe('social:react:self — runtime binding', () => {
  const req = {} as never;

  it('accepts a real subject and refuses anon WITH THIS SCOPE named', () => {
    expect(() =>
      enforceContextBinding({ scopes: [SCOPE], sub: 'user:42' } as never, req, SCOPE)
    ).not.toThrow();
    // Naming the scope rules out the `default:` fail-closed arm being what fired.
    expect(() =>
      enforceContextBinding({ scopes: [SCOPE], sub: 'anon' } as never, req, SCOPE)
    ).toThrow(`${SCOPE} requires authenticated subject`);
  });
});

describe('social:react:self — mint allowlists', () => {
  it('IS in both DEV allowlists (self-bound to the author)', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(SCOPE)).toBe(true);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(true);
  });

  it('🔴 is in NO review or private-run allowlist — a moderator must never react as themselves', () => {
    expect(REVIEW_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(false);
    expect(PRIVATE_RUN_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(false);
    // Positive control: the run-for-real set is not empty-by-accident.
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('ai:write:budgeted')).toBe(true);
  });
});

describe('social:react:self — the canonical manifest schema', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../public/schemas/app-block/v1.json'),
      'utf8'
    )
  );

  it('is declarable, and named in the scopeJustifications prose', () => {
    expect(schema.properties.scopes.items.enum).toContain(SCOPE);
    expect(schema.properties.scopeJustifications.description).toContain(SCOPE);
  });

  it('the enum ORDER still matches the TS map', () => {
    expect(schema.properties.scopes.items.enum).toEqual(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
  });
});
