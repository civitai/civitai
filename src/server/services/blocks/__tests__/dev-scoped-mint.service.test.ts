import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the SHARED dev-scoped block-token mint belt
 * (dev-scoped-mint.service) — the audited clamp + budget + sign logic BOTH the
 * bearer dev-token mint and the Phase-2 cookie dev-tunnel host mint reuse.
 *
 * Locks the security-sensitive invariants that must NOT drift between callers:
 *   - the TUNNEL allowlist STRIPS apps:storage:* (Decision 1); the DEV allowlist
 *     KEEPS it,
 *   - unknown + PAGE_FORBIDDEN + out-of-allowlist scopes are STRIPPED (no error),
 *   - the OAuth ceiling is SKIPPED when oauthAllowed is null (pending/ephemeral —
 *     no client), applied when a bitmask is passed,
 *   - the SPEND ceiling is TWO required predicates: `ai:write:budgeted` survives
 *     only when `spendEntitled && spendRequested` (#3703 step 1),
 *   - `user:read:self` is force-granted, output deduped + sorted,
 *   - the budget clamps to the LOWER dev cap,
 *   - the signed token is self-bound (userId), forced-SFW, dev:true, page ctx.
 */

const { mockSign } = vi.hoisted(() => ({
  mockSign: vi.fn(async (input: unknown) => ({
    token: 'jwt.signed',
    expiresAt: '2099-01-01T00:00:00Z',
    jti: 'j',
    _input: input,
  })),
}));

vi.mock('~/server/services/block-token.service', () => ({
  BlockTokenService: { sign: mockSign },
}));

import {
  clampDevScopes,
  clampTunnelDeclaredScopes,
  DEV_BUZZ_BUDGET_CAP,
  DEV_BUZZ_BUDGET_DEFAULT,
  DEV_TOKEN_SCOPE_ALLOWLIST,
  FORCED_SFW_CEILING,
  parseManifestBuzzBudget,
  resolveDevBuzzBudget,
  REVIEW_MINT_SCOPE_ALLOWLIST,
  REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
  signDevScopedPageToken,
  TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { PAGE_SLOT_ID } from '~/shared/constants/slot-registry';

// AIServicesWrite OAuth bit — models:read:self carries a DIFFERENT bit, so a
// ceiling of just this bit strips models:read:self but keeps ai:write:budgeted.
const AI_WRITE_BIT = 1 << 15;

const FULL_SOURCE = [
  'models:read:self',
  'media:read:owned', // REMOVED decorative scope — now unknown → always stripped
  'ai:write:budgeted',
  'apps:storage:read',
  'apps:storage:write',
  'social:tip:self', // money-OUT — in NO allowlist, always stripped
  'buzz:read:self', // own-ledger READ — in both dev allowlists, NOT the review one
  'block:settings:read', // REMOVED decorative scope — now unknown → always stripped
  'totally:fake:scope', // unknown
];

describe('clampDevScopes', () => {
  it('TUNNEL allowlist STRIPS apps:storage:* (Decision 1) and every non-allowlisted / forbidden / unknown scope', () => {
    const granted = clampDevScopes({
      scopeSource: FULL_SOURCE,
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).toEqual([
      'ai:write:budgeted',
      'buzz:read:self',
      'models:read:self',
      'user:read:self',
    ]);
    // App Storage never survives the tunnel clamp.
    expect(granted).not.toContain('apps:storage:read');
    expect(granted).not.toContain('apps:storage:write');
    // buzz:read:self (own-ledger read) survives; social:tip:self (money OUT) never does.
    expect(granted).toContain('buzz:read:self');
    expect(granted).not.toContain('social:tip:self');
    // Removed decorative scopes are unknown → stripped by step (a) of the clamp.
    expect(granted).not.toContain('media:read:owned');
    expect(granted).not.toContain('block:settings:read');
  });

  it('DEV (bearer) allowlist KEEPS apps:storage:* — the tunnel-vs-bearer difference is exactly storage', () => {
    const granted = clampDevScopes({
      scopeSource: FULL_SOURCE,
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: DEV_TOKEN_SCOPE_ALLOWLIST,
    });
    expect(granted).toContain('apps:storage:read');
    expect(granted).toContain('apps:storage:write');
    // buzz:read:self (own-ledger read) is in the bearer dev allowlist too.
    expect(granted).toContain('buzz:read:self');
    // Still drops money-OUT/unknown/out-of-allowlist.
    expect(granted).not.toContain('social:tip:self');
    expect(granted).not.toContain('block:settings:read');
    expect(granted).not.toContain('totally:fake:scope');
  });

  it('spendEntitled:false STRIPS ai:write:budgeted (read/catalog scopes unaffected)', () => {
    const granted = clampDevScopes({
      scopeSource: ['models:read:self', 'ai:write:budgeted'],
      oauthAllowed: null,
      spendEntitled: false,
      spendRequested: false,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).not.toContain('ai:write:budgeted');
    expect(granted).toEqual(['models:read:self', 'user:read:self']);
  });

  it('OAuth ceiling is SKIPPED when oauthAllowed is null but APPLIED for a bitmask (models:read:self stripped under an AI-only ceiling)', () => {
    const withNull = clampDevScopes({
      scopeSource: ['models:read:self', 'ai:write:budgeted'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    expect(withNull).toContain('models:read:self');

    const withCeiling = clampDevScopes({
      scopeSource: ['models:read:self', 'ai:write:budgeted'],
      oauthAllowed: AI_WRITE_BIT, // allows ai:write:budgeted, NOT models:read:self
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    expect(withCeiling).not.toContain('models:read:self');
    expect(withCeiling).toContain('ai:write:budgeted');
  });

  it('body requestedScopes NARROWS the granted set (subset intersection)', () => {
    const granted = clampDevScopes({
      scopeSource: ['models:read:self', 'media:read:owned', 'ai:write:budgeted'],
      oauthAllowed: null,
      requestedScopes: ['ai:write:budgeted'],
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    // Only the requested scope survives — plus the unconditional force-grant.
    expect(granted).toEqual(['ai:write:budgeted', 'user:read:self']);
  });

  it('always force-grants user:read:self and dedups/sorts (even from an EMPTY source → read-only token)', () => {
    const granted = clampDevScopes({
      scopeSource: [],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).toEqual(['user:read:self']);

    // user:read:self present in source is not duplicated.
    const dedup = clampDevScopes({
      scopeSource: ['user:read:self', 'models:read:self'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    expect(dedup).toEqual(['models:read:self', 'user:read:self']);
  });
});

/**
 * #3703 step 1 — the spend ceiling is TWO independent, both-required predicates.
 *
 * `spendEntitled` (MAY this context spend?) and `spendRequested` (DID the caller ask
 * to spend on THIS mint?) are ANDed. The full 2×2 matrix is pinned below on
 * ENUMERATED granted sets — never `toContain('spend')`-style word checks, which pass
 * while the hazard exists in a different shape.
 *
 * The two false/true rows are what kill an `&&` → `||` mutation, and they kill it in
 * BOTH directions, so neither can be satisfied by the other's guard.
 */
describe('clampDevScopes — the two-predicate spend ceiling (#3703 step 1)', () => {
  // Source declares spend + a read scope. The tunnel allowlist keeps both, so the
  // ONLY thing varying across the matrix is the spend ceiling.
  const SOURCE = ['models:read:self', 'ai:write:budgeted'];
  const WITH_SPEND = ['ai:write:budgeted', 'models:read:self', 'user:read:self'];
  const WITHOUT_SPEND = ['models:read:self', 'user:read:self'];

  const clamp = (spendEntitled: boolean, spendRequested: boolean) =>
    clampDevScopes({
      scopeSource: SOURCE,
      oauthAllowed: null,
      spendEntitled,
      spendRequested,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });

  it('entitled AND requested → the spend scope SURVIVES (not a blanket deny)', () => {
    expect(clamp(true, true)).toEqual(WITH_SPEND);
  });

  it('entitled but NOT requested → the spend scope is STRIPPED (intent binds)', () => {
    expect(clamp(true, false)).toEqual(WITHOUT_SPEND);
  });

  it('requested but NOT entitled → the spend scope is STRIPPED (entitlement binds)', () => {
    // The `&&` → `||` mutant survives every entitled-side test; it dies HERE and on
    // the row above, each on its own exact array.
    expect(clamp(false, true)).toEqual(WITHOUT_SPEND);
  });

  it('neither entitled nor requested → the spend scope is STRIPPED', () => {
    expect(clamp(false, false)).toEqual(WITHOUT_SPEND);
  });

  it('a DENIED spend request is a silent STRIP, never an error — the clamp still returns a usable set', () => {
    // Every other step in this belt is a strip; erroring on the money path would be
    // a NEW failure mode. Asserting the call does not throw is the point.
    expect(() => clamp(false, true)).not.toThrow();
    expect(clamp(false, true)).toEqual(WITHOUT_SPEND);
  });

  it('the ceiling touches ONLY ai:write:budgeted — read/catalog scopes are untouched by either predicate', () => {
    const readSource = ['models:read:self', 'buzz:read:self', 'collections:read:self'];
    const expected = [
      'buzz:read:self',
      'collections:read:self',
      'models:read:self',
      'user:read:self',
    ];
    for (const [e, r] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(
        clampDevScopes({
          scopeSource: readSource,
          oauthAllowed: null,
          spendEntitled: e,
          spendRequested: r,
          allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
        })
      ).toEqual(expected);
    }
  });

  /**
   * RELATIONSHIP GUARD — the two mint paths diverge ON PURPOSE, and the hazard is
   * that they drift apart later. Both halves of the intended asymmetry are asserted
   * HERE, in one place, so the divergence is stated once and cannot rot in two.
   */
  it('ASYMMETRY: the tunnel path grants spend with NO request input, while a bearer that did not request it does NOT', () => {
    // TUNNEL half — `clampTunnelDeclaredScopes` takes ONE argument. There is no
    // request field to pass, because the declaring manifest IS the request; the
    // wrapper hardcodes spendEntitled/spendRequested = true/true, permanently.
    expect(clampTunnelDeclaredScopes(SOURCE)).toEqual(WITH_SPEND);
    expect(clampTunnelDeclaredScopes.length).toBe(1);

    // BEARER half — the same source, the same allowlist, spend-entitled, but the
    // caller declined spend for this mint → stripped.
    expect(clamp(true, false)).toEqual(WITHOUT_SPEND);

    // …and the divergence is EXACTLY the spend scope: the rest of the set matches.
    expect(clampTunnelDeclaredScopes(SOURCE).filter((s) => s !== 'ai:write:budgeted')).toEqual(
      clamp(true, false)
    );
  });

  /**
   * PARITY WITH BASE — the tunnel path must be BYTE-IDENTICAL to pre-#3703
   * behaviour. These enumerated sets are the pre-change outputs; they are what a
   * wrong wrapper value (the persisted-`grantedScopes` hazard) would break.
   */
  it('PARITY: clampTunnelDeclaredScopes output is unchanged for the representative inputs', () => {
    expect(
      clampTunnelDeclaredScopes([
        'models:read:self',
        'ai:write:budgeted',
        'apps:storage:write', // not in the tunnel allowlist → stripped
        'social:tip:self', // money OUT → stripped
        'buzz:read:self',
      ])
    ).toEqual(['ai:write:budgeted', 'buzz:read:self', 'models:read:self', 'user:read:self']);
    expect(clampTunnelDeclaredScopes([])).toEqual(['user:read:self']);
    expect(clampTunnelDeclaredScopes(['ai:write:budgeted'])).toEqual([
      'ai:write:budgeted',
      'user:read:self',
    ]);
  });
});

describe('buzz:read:self allowlist membership (own-ledger read, self-bound)', () => {
  it('is in BOTH dev allowlists but NOT the mod-review sandbox allowlist', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has('buzz:read:self')).toBe(true);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has('buzz:read:self')).toBe(true);
    expect(REVIEW_MINT_SCOPE_ALLOWLIST.has('buzz:read:self')).toBe(false);
  });

  it('the money-OUT scope social:tip:self is in NONE of the allowlists', () => {
    expect(DEV_TOKEN_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
    expect(TUNNEL_HOST_MINT_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
    expect(REVIEW_MINT_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
  });

  it('a dev-tunnel manifest requesting buzz:read:self KEEPS the scope through the clamp (consent works)', () => {
    const granted = clampDevScopes({
      scopeSource: ['buzz:read:self', 'models:read:self'],
      oauthAllowed: null, // pre-approval dev tunnel — no OauthClient
      spendEntitled: true,
      spendRequested: true,
      allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
    });
    // The scope survives → the block's REQUEST_CONSENT resolves a real
    // missingScope instead of an empty set (the reported "dead button" bug).
    expect(granted).toContain('buzz:read:self');
    expect(granted).toEqual(['buzz:read:self', 'models:read:self', 'user:read:self']);
  });

  it('the mod-review sandbox STRIPS buzz:read:self even when the pending manifest declares it', () => {
    const granted = clampDevScopes({
      scopeSource: ['buzz:read:self', 'models:read:self'],
      oauthAllowed: null,
      spendEntitled: false,
      spendRequested: false,
      allowlist: REVIEW_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).not.toContain('buzz:read:self');
  });
});

describe('clampDevScopes — REVIEW_MINT_SCOPE_ALLOWLIST (mod review sandbox #2831)', () => {
  // The pending manifest a MALICIOUS app could declare: it asks for spend, per-user
  // + shared storage, private collections, real-money tip, and financial read.
  const MALICIOUS_MANIFEST_SCOPES = [
    'models:read:self',
    'media:read:owned', // removed decorative scope — unknown → stripped
    'collections:read:self',
    'ai:write:budgeted',
    'apps:storage:read',
    'apps:storage:write',
    'apps:storage:shared:read',
    'apps:storage:shared:write',
    'collections:read:private',
    'collections:write:self',
    'social:tip:self',
    'buzz:read:self',
  ];

  it('strips EVERY money/private/cross-user/write scope — only the render-only reads survive', () => {
    const granted = clampDevScopes({
      scopeSource: MALICIOUS_MANIFEST_SCOPES,
      oauthAllowed: null, // pending app — no OauthClient
      spendEntitled: false,
      spendRequested: false, // review preview never spends (belt-and-suspenders)
      allowlist: REVIEW_MINT_SCOPE_ALLOWLIST,
    });
    // ONLY the render-only survivors (+ the unconditional user:read:self grant).
    expect(granted).toEqual([
      'collections:read:self',
      'models:read:self',
      'user:read:self',
    ]);
    // None of the withheld scopes can EVER reach the review JWT.
    for (const withheld of [
      'media:read:owned', // removed decorative scope — unknown → stripped
      'ai:write:budgeted',
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
      'collections:read:private',
      'collections:write:self',
      'social:tip:self',
      'buzz:read:self',
    ]) {
      expect(granted).not.toContain(withheld);
    }
  });

  it('is STRICTER than the dev-tunnel allowlist — never grants ai:write:budgeted even with both spend predicates true', () => {
    // Even if a caller mistakenly passed both spend predicates true, the allowlist itself
    // omits ai:write:budgeted, so spend can never survive the review clamp.
    const granted = clampDevScopes({
      scopeSource: ['ai:write:budgeted', 'models:read:self'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: REVIEW_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).not.toContain('ai:write:budgeted');
    expect(granted).toEqual(['models:read:self', 'user:read:self']);
  });

  it('an EMPTY manifest still yields a usable read-only token (force-granted user:read:self)', () => {
    const granted = clampDevScopes({
      scopeSource: [],
      oauthAllowed: null,
      spendEntitled: false,
      spendRequested: false,
      allowlist: REVIEW_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).toEqual(['user:read:self']);
  });
});

describe('clampDevScopes — REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST (mod opt-in #2831)', () => {
  // The SAME malicious manifest — now clamped through the WIDER run-for-real belt.
  const MALICIOUS_MANIFEST_SCOPES = [
    'models:read:self',
    'media:read:owned', // removed decorative scope — unknown → stripped
    'collections:read:self',
    'ai:write:budgeted',
    'apps:storage:read',
    'apps:storage:write',
    'apps:storage:shared:read',
    'apps:storage:shared:write',
    'collections:read:private',
    'collections:write:self',
    'social:tip:self',
    'buzz:read:self',
  ];

  it('grants ONLY declared ∩ allowlist — spend + own storage + own buzz survive, cross-user/private/money-out do NOT', () => {
    const granted = clampDevScopes({
      scopeSource: MALICIOUS_MANIFEST_SCOPES,
      oauthAllowed: null, // pending app — no OauthClient
      spendEntitled: true,
      spendRequested: true, // run-for-real spends the mod's OWN Buzz
      allowlist: REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).toEqual([
      'ai:write:budgeted',
      'apps:storage:read',
      'apps:storage:write',
      'buzz:read:self',
      'collections:read:self',
      'models:read:self',
      'user:read:self',
    ]);
    // Clamp holds against a malicious manifest — none of these can EVER survive.
    for (const withheld of [
      'apps:storage:shared:read', // cross-user
      'apps:storage:shared:write', // cross-user write
      'collections:read:private', // private
      'collections:write:self', // write surface
      'social:tip:self', // money OUT — excluded by the allowlist (NOT PAGE_FORBIDDEN)
      'media:read:owned', // unknown
    ]) {
      expect(granted).not.toContain(withheld);
    }
  });

  it('NEVER grants social:tip:self even with both spend predicates true — the ALLOWLIST is the sole money-out gate (PAGE_FORBIDDEN is empty)', () => {
    // PAGE_FORBIDDEN_SCOPES is intentionally empty (a PROD page token legitimately
    // carries a bounded social:tip:self tip button), so the review-sandbox exclusion
    // is the allowlist ALONE — assert both the allowlist omits it AND a manifest
    // declaring it gets it stripped by the clamp.
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('social:tip:self')).toBe(false);
    const granted = clampDevScopes({
      scopeSource: ['social:tip:self', 'ai:write:budgeted'],
      oauthAllowed: null,
      spendEntitled: true,
      spendRequested: true,
      allowlist: REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).not.toContain('social:tip:self');
    expect(granted).toContain('ai:write:budgeted');
  });

  it('spendEntitled:false STILL strips the spend scope (belt-and-suspenders) even under the wider allowlist', () => {
    const granted = clampDevScopes({
      scopeSource: ['ai:write:budgeted', 'models:read:self'],
      oauthAllowed: null,
      spendEntitled: false,
      spendRequested: false,
      allowlist: REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
    });
    expect(granted).not.toContain('ai:write:budgeted');
  });

  it('withholds cross-user shared storage the run-for-real allowlist never lists', () => {
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('apps:storage:shared:read')).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('apps:storage:shared:write')).toBe(false);
    expect(REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST.has('collections:read:private')).toBe(false);
  });
});

describe('signDevScopedPageToken — reviewRunForReal claim (#2831)', () => {
  it('stamps reviewRunForReal:true ONLY when the flag is set (absent otherwise)', async () => {
    const withFlag = (await signDevScopedPageToken({
      userId: 7,
      signBlockId: 'b',
      signAppId: 'pending-x',
      signAppBlockId: 'pubreq_x',
      blockInstanceId: 'page_x',
      granted: ['ai:write:budgeted', 'user:read:self'],
      buzzBudget: 50,
      reviewRunForReal: true,
    })) as unknown as { _input: Record<string, unknown> };
    expect(withFlag._input.reviewRunForReal).toBe(true);
    // Still self-bound, forced-SFW, dev lifetime.
    expect(withFlag._input.userId).toBe(7);
    expect(withFlag._input.maxBrowsingLevel).toBe(FORCED_SFW_CEILING);
    expect(withFlag._input.dev).toBe(true);

    const withoutFlag = (await signDevScopedPageToken({
      userId: 7,
      signBlockId: 'b',
      signAppId: 'pending-x',
      signAppBlockId: 'pubreq_x',
      blockInstanceId: 'page_x',
      granted: ['user:read:self'],
      buzzBudget: undefined,
    })) as unknown as { _input: Record<string, unknown> };
    expect(withoutFlag._input.reviewRunForReal).toBeUndefined();
  });
});

describe('resolveDevBuzzBudget', () => {
  it('returns undefined when ai:write:budgeted was not granted', () => {
    expect(resolveDevBuzzBudget(['user:read:self'])).toBeUndefined();
  });
  it('clamps a requested budget to the LOWER dev cap', () => {
    expect(resolveDevBuzzBudget(['ai:write:budgeted'], 100000)).toBe(DEV_BUZZ_BUDGET_CAP);
    expect(resolveDevBuzzBudget(['ai:write:budgeted'], 10)).toBe(10);
  });
  it('defaults to DEV_BUZZ_BUDGET_DEFAULT when no budget is requested AND no manifest default', () => {
    expect(resolveDevBuzzBudget(['ai:write:budgeted'])).toBe(DEV_BUZZ_BUDGET_DEFAULT);
  });

  // Fix 2 (dogfood follow-up): a recipe/app whose manifest budget exceeds the flat
  // 50 default must be dev-testable without a manual budget request.
  it('DEFAULTS to the resolved app manifest budget when present (no explicit request)', () => {
    // manifest page.buzzBudgetPerGen = 180 (> the flat 50 default) → 180.
    expect(resolveDevBuzzBudget(['ai:write:budgeted'], undefined, 180)).toBe(180);
  });
  it('clamps a manifest default above the CAP to DEV_BUZZ_BUDGET_CAP', () => {
    expect(resolveDevBuzzBudget(['ai:write:budgeted'], undefined, 100000)).toBe(
      DEV_BUZZ_BUDGET_CAP
    );
  });
  it('an EXPLICIT requested budget still wins over the manifest default', () => {
    // requestedBudget (30) takes precedence over the manifest default (180).
    expect(resolveDevBuzzBudget(['ai:write:budgeted'], 30, 180)).toBe(30);
  });
  it('falls back to the flat default when the manifest default is absent (ephemeral no-row mode)', () => {
    expect(resolveDevBuzzBudget(['ai:write:budgeted'], undefined, undefined)).toBe(
      DEV_BUZZ_BUDGET_DEFAULT
    );
  });
  it('never mints a budget when ai:write:budgeted was not granted, even with a manifest default', () => {
    expect(resolveDevBuzzBudget(['user:read:self'], undefined, 180)).toBeUndefined();
  });
});

describe('parseManifestBuzzBudget', () => {
  it('returns the positive-integer page.buzzBudgetPerGen', () => {
    expect(parseManifestBuzzBudget({ path: '/', buzzBudgetPerGen: 180 })).toBe(180);
  });
  it('returns undefined when the field is absent (→ caller uses the flat default)', () => {
    expect(parseManifestBuzzBudget({ path: '/', title: 'X' })).toBeUndefined();
  });
  it.each([
    ['fractional', 12.5],
    ['zero', 0],
    ['negative', -10],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string', '180' as unknown as number],
  ])('ignores a %s budget (→ undefined, never flowed through)', (_label, value) => {
    expect(parseManifestBuzzBudget({ buzzBudgetPerGen: value })).toBeUndefined();
  });
  it.each([[null], [undefined], ['not-an-object'], [[1, 2, 3]]])(
    'returns undefined for a non-object page (%s)',
    (page) => {
      expect(parseManifestBuzzBudget(page)).toBeUndefined();
    }
  );
});

describe('signDevScopedPageToken', () => {
  beforeEach(() => mockSign.mockClear());

  it('signs a SELF-BOUND, forced-SFW, dev:true PAGE token with the synthetic ids verbatim', async () => {
    const res = await signDevScopedPageToken({
      userId: 777,
      signBlockId: 'my-app',
      signAppId: 'ephemeral-my-app',
      signAppBlockId: 'ephemeral-my-app',
      blockInstanceId: 'page_ephemeral-my-app',
      granted: ['ai:write:budgeted', 'user:read:self'],
      buzzBudget: 50,
    });
    expect(res.token).toBe('jwt.signed');
    expect(mockSign).toHaveBeenCalledTimes(1);
    const arg = mockSign.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.userId).toBe(777); // self-bound
    expect(arg.dev).toBe(true); // 4h dev lifetime
    expect(arg.domain).toBeNull(); // never reads a host
    expect(arg.maxBrowsingLevel).toBe(FORCED_SFW_CEILING); // forced SFW
    expect(arg.appId).toBe('ephemeral-my-app'); // synthetic, non-resolving
    expect(arg.appBlockId).toBe('ephemeral-my-app');
    expect(arg.blockInstanceId).toBe('page_ephemeral-my-app');
    expect(arg.buzzBudget).toBe(50);
    // PAGE ctx (entity=none, no modelId) — can never satisfy a model-bound check.
    expect(arg.ctx).toEqual({ slotId: PAGE_SLOT_ID, entityType: 'none' });
  });
});
