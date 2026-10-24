import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
  isSensitiveBlockScope,
  SENSITIVE_BLOCK_SCOPES,
  SKIP_OAUTH_CHECK,
  unjustifiedSensitiveScopes,
} from '~/shared/constants/block-scope.constants';
import {
  consentGatedScopes,
  partitionByConsent,
} from '~/server/services/blocks/scope-grant.service';
import {
  DEV_TOKEN_SCOPE_ALLOWLIST,
  REVIEW_MINT_SCOPE_ALLOWLIST,
  REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
  TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { enforceContextBinding } from '~/server/middleware/block-scope.middleware';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { READ_SCOPE_LABELS } from '~/shared/constants/block-action-detail';
import { scopeBucketLabel } from '~/components/AppBlocks/analytics-bucket-labels';

/**
 * `goods:purchase:self` + `goods:read:self` — the full wiring ledger, modelled
 * on `posts-write-scope-plumbing.test.ts` for the same reason it exists: every
 * one of these seams fails SILENTLY AND PLAUSIBLY.
 *
 *   - MISSING MIDDLEWARE CASE → the scope is known but unbound, so
 *     `enforceContextBinding`'s `default:` arm 403s every request to the route
 *     that declares it. The buy button is simply dead, and the error names an
 *     internal wiring state rather than anything the caller did.
 *   - NEITHER EXEMPT NOR PROMPTED → stripped at mint with a correct-looking
 *     runtime and schema.
 *   - NOT SENSITIVE → no `scopeJustifications` requirement, so an app asking to
 *     charge the viewer ships past review unexplained.
 *   - NO DESCRIPTION → the consent modal shows a raw scope id for a permission
 *     that spends money.
 *   - IN A REVIEW ALLOWLIST → a moderator evaluating an UNAPPROVED third-party
 *     app is charged by it.
 *   - NO ANALYTICS LABEL → the owner dashboard renders the raw scope string.
 */

const PURCHASE = 'goods:purchase:self';
const READ = 'goods:read:self';

describe('goods scopes — registry', () => {
  it('both are known scopes', () => {
    expect(isKnownBlockScope(PURCHASE)).toBe(true);
    expect(isKnownBlockScope(READ)).toBe(true);
  });

  it('both use SKIP_OAUTH_CHECK rather than borrowing another capability’s bit', () => {
    // 🔴 The alternative that must not happen: reusing `TokenScope.SocialTip`
    // would let every app already approved to tip start selling goods.
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[PURCHASE]).toBe(SKIP_OAUTH_CHECK);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[READ]).toBe(SKIP_OAUTH_CHECK);
  });

  it('the PURCHASE half is SENSITIVE and the READ half is not', () => {
    expect(isSensitiveBlockScope(PURCHASE)).toBe(true);
    expect(SENSITIVE_BLOCK_SCOPES.has(PURCHASE)).toBe(true);
    expect(isSensitiveBlockScope(READ)).toBe(false);
  });

  it('a manifest declaring the purchase scope MUST justify it', () => {
    expect(unjustifiedSensitiveScopes({ scopes: [PURCHASE] })).toEqual([PURCHASE]);
    expect(
      unjustifiedSensitiveScopes({
        scopes: [PURCHASE],
        scopeJustifications: { [PURCHASE]: 'We sell extra save slots.' },
      })
    ).toEqual([]);
    // Whitespace is not a justification.
    expect(
      unjustifiedSensitiveScopes({ scopes: [PURCHASE], scopeJustifications: { [PURCHASE]: '  ' } })
    ).toEqual([PURCHASE]);
    // And the read half needs none.
    expect(unjustifiedSensitiveScopes({ scopes: [READ] })).toEqual([]);
  });

  it('both have a consent description that names the ACTION, not just the resource', () => {
    expect(SCOPE_DESCRIPTIONS[PURCHASE].toLowerCase()).toContain('buy');
    expect(SCOPE_DESCRIPTIONS[READ].toLowerCase()).toContain('own');
  });

  it('both render a human label rather than the raw scope id', () => {
    // The drift guard in analytics-bucket-labels.drift.test.ts fails on a
    // `requiredScope` literal with no label; this pins the OUTPUT, so a label
    // added as the scope string itself would still be caught here.
    expect(scopeBucketLabel(PURCHASE)).not.toBe(PURCHASE);
    expect(scopeBucketLabel(READ)).not.toBe(READ);
    expect(READ_SCOPE_LABELS[READ]).toBeTruthy();
  });
});

describe('goods scopes — consent', () => {
  it('the PURCHASE half is consent-GATED: withheld until granted', () => {
    expect(consentGatedScopes([PURCHASE])).toContain(PURCHASE);
    const before = partitionByConsent([PURCHASE], new Set<string>());
    expect(before.signable).not.toContain(PURCHASE);
    expect(before.missing).toContain(PURCHASE);

    const after = partitionByConsent([PURCHASE], new Set([PURCHASE]));
    expect(after.signable).toEqual([PURCHASE]);
    expect(after.missing).toEqual([]);
  });

  it('a grant for a DIFFERENT scope does not unlock the purchase scope', () => {
    // Positive control for the case above: without it a mutant that ignored the
    // grant set and always signed would still pass.
    const { signable, missing } = partitionByConsent([PURCHASE], new Set([READ]));
    expect(signable).not.toContain(PURCHASE);
    expect(missing).toContain(PURCHASE);
  });

  it('the READ half is consent-EXEMPT — it answers only with what this app sold', () => {
    expect(consentGatedScopes([READ])).not.toContain(READ);
    const { signable, missing } = partitionByConsent([READ], new Set<string>());
    expect(signable).toContain(READ);
    expect(missing).not.toContain(READ);
  });
});

describe('goods scopes — runtime binding in enforceContextBinding', () => {
  const req = {} as never;

  it('ACCEPT a real user subject', () => {
    for (const scope of [PURCHASE, READ]) {
      expect(() =>
        enforceContextBinding({ scopes: [scope], sub: 'user:42' } as never, req, scope)
      ).not.toThrow();
    }
  });

  it('REFUSE an anonymous subject, with THIS scope named in the error', () => {
    // The message must name the scope. A generic "forbidden" would pass while
    // the `default:` fail-closed arm was what actually fired — the exact
    // mis-attribution this case rules out.
    for (const scope of [PURCHASE, READ]) {
      expect(() =>
        enforceContextBinding({ scopes: [scope], sub: 'anon' } as never, req, scope)
      ).toThrow(`${scope} requires authenticated subject`);
    }
  });

  it('do not interfere with a route requiring a DIFFERENT scope', () => {
    // An ANON subject is what makes this bite: the goods scopes REFUSE anon,
    // `apps:storage:shared:read` ALLOWS it, so this passes only while the
    // switch is fed the route's own `requiredScope`.
    expect(() =>
      enforceContextBinding(
        { scopes: ['apps:storage:shared:read', PURCHASE, READ], sub: 'anon' } as never,
        req,
        'apps:storage:shared:read'
      )
    ).not.toThrow();
    // Positive control for the pairing: the SAME anon token IS refused when the
    // route actually requires the purchase scope.
    expect(() =>
      enforceContextBinding(
        { scopes: ['apps:storage:shared:read', PURCHASE, READ], sub: 'anon' } as never,
        req,
        PURCHASE
      )
    ).toThrow(`${PURCHASE} requires authenticated subject`);
    // And the negative control proving the unknown-scope arm is reachable.
    expect(() =>
      enforceContextBinding(
        { scopes: ['goods:purchase:everyone'], sub: 'user:42' } as never,
        req,
        'goods:purchase:everyone'
      )
    ).toThrow('unknown scope: goods:purchase:everyone');
  });
});

describe('goods scopes — mint allowlists', () => {
  it('🔴 the PURCHASE scope is in NO allowlist — no real money OUT in dev or review', () => {
    for (const allowlist of [
      DEV_TOKEN_SCOPE_ALLOWLIST,
      TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
      REVIEW_MINT_SCOPE_ALLOWLIST,
      REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
    ]) {
      expect(allowlist.has(PURCHASE)).toBe(false);
    }
    // Pinned beside `social:tip:self`, the other never-minted money-OUT scope,
    // so this reads as a set membership rather than a lone opinion — and beside
    // `ai:write:budgeted`, which IS granted for run-for-real, so "the mod
    // consented to consequences" is visibly not the deciding argument.
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('ai:write:budgeted')).toBe(true);
  });

  it('the READ scope is in both DEV allowlists and neither REVIEW allowlist', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(READ)).toBe(true);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has(READ)).toBe(true);
    expect(REVIEW_MINT_SCOPE_ALLOWLIST.has(READ)).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(READ)).toBe(false);
  });
});

describe('goods scopes — the canonical manifest schema', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../public/schemas/app-block/v1.json'),
      'utf8'
    )
  );

  it('both are declarable in a manifest', () => {
    expect(schema.properties.scopes.items.enum).toContain(PURCHASE);
    expect(schema.properties.scopes.items.enum).toContain(READ);
  });

  it('the PURCHASE scope appears in the scopeJustifications prose — a hand-maintained copy of the sensitive set', () => {
    expect(schema.properties.scopeJustifications.description).toContain(PURCHASE);
    // And the read half must NOT be listed there, or authors are told to
    // justify something the validator does not require.
    expect(schema.properties.scopeJustifications.description).not.toContain(READ);
  });

  it('the enum ORDER still matches the TS map — the drift test is toEqual, not a set compare', () => {
    expect(schema.properties.scopes.items.enum).toEqual(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
  });
});
