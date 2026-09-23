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
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `posts:write:self` — the full wiring ledger.
 *
 * 🔴 EVERY ONE OF THESE SEAMS FAILS *SILENTLY AND PLAUSIBLY*. That is what this
 * file is for; none of them throws at build time and none is visible from
 * reading the constant:
 *
 *   - MISSING MIDDLEWARE CASE → the scope is known but unbound, so
 *     `enforceContextBinding`'s `default:` arm 403s every request to the route
 *     that declares it as `requiredScope`: the posting route is simply dead, and
 *     the error names an internal wiring state rather than anything the caller
 *     did. (Before #5063 this was WIDER — the binding switch ran for every scope
 *     on the token, so an unbound scope 403'd every REST request the token made,
 *     bricking the whole app. `block-scope.required-scope-binding.test.ts` now
 *     also pins the "every known scope has a case" property statically.)
 *   - NEITHER EXEMPT NOR PROMPTED → stripped at mint with a correct-looking
 *     runtime. (The end-to-end proof of the prompted half is in
 *     `src/tests/api/v1/block-tokens/page-mint.test.ts`, driven through the real
 *     handler; what this file pins is the partition rule it rests on.)
 *   - NOT SENSITIVE → no `scopeJustifications` requirement, so the most
 *     consequential permission in the vocabulary ships past review unexplained.
 *   - NO DESCRIPTION → the consent modal shows the viewer a raw scope id for a
 *     publish permission. A consent-quality defect, not a cosmetic one.
 *   - IN A REVIEW ALLOWLIST → a moderator previewing an UNAPPROVED third-party
 *     app publishes public content under the MOD'S OWN name.
 */

const SCOPE = 'posts:write:self';

describe('posts:write:self — registry', () => {
  it('is a known scope backed by the REAL MediaWrite OAuth bit, not SKIP_OAUTH_CHECK', () => {
    expect(isKnownBlockScope(SCOPE)).toBe(true);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[SCOPE]).toBe(TokenScope.MediaWrite);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[SCOPE]).not.toBe(SKIP_OAUTH_CHECK);
  });

  it('is SENSITIVE, so a manifest declaring it MUST justify it', () => {
    expect(isSensitiveBlockScope(SCOPE)).toBe(true);
    expect(SENSITIVE_BLOCK_SCOPES.has(SCOPE)).toBe(true);

    // The consequence, not just the membership: an unjustified declaration is
    // reported, and a justified one is not.
    expect(unjustifiedSensitiveScopes({ scopes: [SCOPE] })).toEqual([SCOPE]);
    expect(
      unjustifiedSensitiveScopes({
        scopes: [SCOPE],
        scopeJustifications: { [SCOPE]: 'We publish the results the user just generated.' },
      })
    ).toEqual([]);
    // Whitespace is not a justification.
    expect(
      unjustifiedSensitiveScopes({ scopes: [SCOPE], scopeJustifications: { [SCOPE]: '   ' } })
    ).toEqual([SCOPE]);
  });

  it('has a human-readable consent description', () => {
    const description = SCOPE_DESCRIPTIONS[SCOPE];
    expect(typeof description).toBe('string');
    expect(description.length).toBeGreaterThan(0);
    // The description is what the viewer reads in the consent modal, so it must
    // name the ACTION, not merely the resource.
    expect(description.toLowerCase()).toContain('post');
  });
});

describe('posts:write:self — CONSENT-PROMPTED, not exempt', () => {
  it('is in the consent-gated set', () => {
    expect(consentGatedScopes([SCOPE])).toContain(SCOPE);
  });

  it('with NO grant it is WITHHELD and reported as missing', () => {
    const { signable, missing } = partitionByConsent([SCOPE], new Set<string>());
    expect(signable).not.toContain(SCOPE);
    expect(missing).toContain(SCOPE);
  });

  it('with a grant it becomes signable', () => {
    const { signable, missing } = partitionByConsent([SCOPE], new Set([SCOPE]));
    expect(signable).toEqual([SCOPE]);
    expect(missing).toEqual([]);
  });

  it('a grant for a DIFFERENT scope does not unlock it', () => {
    // The positive control for the case above: without this, a mutant that
    // ignored the grant set entirely and always signed would still pass.
    const { signable, missing } = partitionByConsent(
      [SCOPE],
      new Set(['collections:read:private'])
    );
    expect(signable).not.toContain(SCOPE);
    expect(missing).toContain(SCOPE);
  });
});

describe('posts:write:self — runtime binding in enforceContextBinding', () => {
  const req = {} as never;

  it('ACCEPTS a token with a real user subject', () => {
    expect(() =>
      enforceContextBinding({ scopes: [SCOPE], sub: 'user:42' } as never, req, SCOPE)
    ).not.toThrow();
  });

  it('REFUSES an anonymous subject — there is no anonymous profile to post to', () => {
    // The message must name THIS scope. A generic "forbidden" would pass while
    // the `default:` fail-closed arm was the thing that actually fired, which is
    // the exact mis-attribution this case exists to rule out.
    expect(() => enforceContextBinding({ scopes: [SCOPE], sub: 'anon' } as never, req, SCOPE)).toThrow(
      `${SCOPE} requires authenticated subject`
    );
  });

  it('does NOT interfere with a route that requires a DIFFERENT scope', () => {
    // 🔴 WHAT THIS ONCE GUARDED, AND WHY IT IS WEAKER NOW — say so rather than
    // let it read as stronger coverage than it is. It used to be THE
    // high-blast-radius case: the binding switch walked EVERY scope on the
    // token, so an unbound `posts:write:self` 403'd a models read too, and this
    // assertion was the only thing standing between a wiring slip and a bricked
    // app. #5063 narrowed the switch to the route's `requiredScope`, so the
    // interference this rules out is now structurally impossible rather than
    // merely absent, and the case that replaces it — every known scope HAS a
    // binding case — is asserted statically in
    // `src/server/middleware/__tests__/block-scope.required-scope-binding.test.ts`.
    // Kept as the cross-scope no-interference assertion for THIS scope.
    expect(() =>
      enforceContextBinding(
        { scopes: ['user:read:self', SCOPE], sub: 'user:42' } as never,
        req,
        'user:read:self'
      )
    ).not.toThrow();
    // And the negative control proving that arm is reachable at all: an invented
    // scope is rejected as UNKNOWN (the token-wide gate before the switch, which
    // did NOT narrow).
    expect(() =>
      enforceContextBinding(
        { scopes: ['posts:write:everyone'], sub: 'user:42' } as never,
        req,
        'posts:write:everyone'
      )
    ).toThrow('unknown scope: posts:write:everyone');
  });
});

describe('posts:write:self — mint allowlists', () => {
  it('IS in both DEV allowlists — an author must be able to iterate on their own profile', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has(SCOPE)).toBe(true);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(true);
  });

  it('🔴 is in NEITHER review allowlist — a mod must never publish as themselves for an unapproved app', () => {
    expect(REVIEW_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has(SCOPE)).toBe(false);
    // Including the run-for-real one, which DOES grant real Buzz spend — so
    // "the mod already consented to consequences" is not an argument for adding
    // it. Pinned beside `social:tip:self`, the other never-in-review scope, so
    // this reads as a set membership rather than a lone opinion.
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('ai:write:budgeted')).toBe(true);
  });
});

describe('posts:write:self — the canonical manifest schema', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../public/schemas/app-block/v1.json'),
      'utf8'
    )
  );

  it('is declarable in a manifest', () => {
    expect(schema.properties.scopes.items.enum).toContain(SCOPE);
  });

  it('appears in the scopeJustifications prose — the FOURTH copy of the sensitive set', () => {
    // That prose is a hand-maintained duplicate of SENSITIVE_BLOCK_SCOPES with no
    // structural guard, so it is asserted here rather than trusted. (The other
    // copies: the TS constant, the Go CLI map, and the CLI's enum-message test.)
    expect(schema.properties.scopeJustifications.description).toContain(SCOPE);
  });

  it('the enum ORDER still matches the TS map — the drift test is toEqual, not a set compare', () => {
    expect(schema.properties.scopes.items.enum).toEqual(Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT));
  });
});
