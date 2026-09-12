import { describe, expect, it } from 'vitest';
import { projectListingDetail } from '~/server/services/blocks/app-listing.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `ListingDetail.connectScopes` — the PUBLIC disclosure of the OAuth permissions an
 * off-site connect listing will request (clawgate #555).
 *
 * NODE tier on purpose. The browser tier is report-only in CI and therefore cannot
 * gate a merge, and what is being pinned here is a PUBLIC DTO's contents — the one
 * thing that must not regress silently, since it crosses the unauthenticated
 * `GET /api/v1/apps/{slug}` boundary.
 *
 * 🔴 EVERY FIXTURE MASK IS BUILT FROM NAMED `TokenScope` MEMBERS, NEVER A LITERAL
 * INT. A hardcoded `114689` asserts nothing about the decode: it would still pass if
 * the shared bit table were renumbered, which is exactly the drift this projection's
 * comment says would be a latent security bug. Naming the members means the fixture
 * moves with the table and a renumber cannot pass silently.
 */

/** The minimum row shape `projectListingDetail` reads. Cast at the call, because the
 *  real select is far wider and none of the rest participates in this projection. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apl_1',
    slug: 'an-app',
    name: 'An App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'pg',
    status: 'approved',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    kind: 'offsite',
    externalUrl: 'https://example.com',
    connectClientId: 'oauth-1',
    connectRequestedScopes: null,
    appBlock: null,
    screenshots: [],
    metric: null,
    user: null,
    ...overrides,
  };
}

const project = (overrides: Record<string, unknown> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectListingDetail(row(overrides) as any, [], null, {
    isBeta: false,
    betaMessage: null,
  } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('ListingDetail.connectScopes', () => {
  it('decodes an off-site connect listing’s requested bitmask into TokenScope enum-keys', () => {
    const mask =
      TokenScope.UserRead |
      TokenScope.AIServicesRead |
      TokenScope.AIServicesWrite |
      TokenScope.BuzzRead;

    const detail = project({ connectRequestedScopes: mask });

    // Exact set, not a `toContain` — an over-disclosure is as much a defect as an
    // under-disclosure on a public surface, and only an exact assertion catches it.
    expect(detail.connectScopes).toEqual([
      'UserRead',
      'AIServicesRead',
      'AIServicesWrite',
      'BuzzRead',
    ]);
  });

  it('orders by ascending bit so the wire order is stable across requests', () => {
    // Built in DESCENDING bit order on purpose: if the projection ever preserved
    // input/insertion order instead of the shared table's sort, this is what would
    // catch it. `toEqual` on an array is order-sensitive.
    const mask = TokenScope.VaultRead | TokenScope.ModelsRead | TokenScope.UserRead;
    expect(project({ connectRequestedScopes: mask }).connectScopes).toEqual([
      'UserRead',
      'ModelsRead',
      'VaultRead',
    ]);
  });

  it('is [] when the column is NULL, and [] at a zero mask', () => {
    expect(project({ connectRequestedScopes: null }).connectScopes).toEqual([]);
    // 0 is a NUMBER, so it passes the `typeof === 'number'` guard and reaches the
    // decode — this pins that the empty result comes from the decode rather than
    // from the guard, which a NULL-only test cannot distinguish.
    expect(project({ connectRequestedScopes: 0 }).connectScopes).toEqual([]);
  });

  it('is [] for an ON-SITE row even when the column is populated', () => {
    // The gate is on `kind`, never on the column's nullness — `mapAppBlockToListing`
    // can mint an offsite kind WITH a backing appBlockId, so the two predicates are
    // not interchangeable. A populated mask on an onsite row must still disclose
    // nothing through this field.
    const detail = project({
      kind: 'onsite',
      connectRequestedScopes: TokenScope.UserRead | TokenScope.BuzzRead,
    });
    expect(detail.connectScopes).toEqual([]);
  });

  // ⚠ There is deliberately NO separate `undefined` case. The guard is
  // `typeof row.connectRequestedScopes === 'number'`, so `undefined` and `null` take
  // the identical branch — a second test would assert the same line twice and read as
  // coverage of a distinct path. Removed on the round-0 audit's D4. The `0` half of
  // the NULL test above is the one that IS distinct, because `0` passes the guard and
  // reaches the decode.

  /**
   * 🔴 THE APPROVED-ONLY GUARANTEE IS UPSTREAM, AND THIS IS WHAT PINS THE RELIANCE.
   *
   * The projection carries NO status clause, deliberately: `getListingDetail`
   * returns null for `status !== 'approved'` before reaching it, while
   * `getListingPreviewForReview` is deliberately NOT status-filtered so a moderator
   * can preview a draft. So the projection MUST keep disclosing for a non-approved
   * row — a status gate here would be unreachable on the public path and would blank
   * the moderator's own preview on the other.
   *
   * That makes "drafts stay private" a property of the CALLER, which is the thing a
   * future reader is most likely to un-verify. Asserting the projection still
   * discloses at `status: 'draft'` is what makes the split explicit: if someone
   * "fixes" it by adding a status clause here, this fails and points them at the
   * caller instead.
   */
  it('still decodes for a NON-APPROVED row — the public gate is getListingDetail’s, not this projection’s', () => {
    const detail = project({
      status: 'draft',
      connectRequestedScopes: TokenScope.UserRead,
    });
    expect(detail.connectScopes).toEqual(['UserRead']);
  });

  /**
   * ⚠ AN INVARIANT GUARD, NOT REGRESSION COVERAGE — it is the ONE case in this file
   * that PASSES at the pre-change commit, because the DTO carried no justification
   * text before this change either. Labelled rather than counted: the red-at-base
   * matrix for this file is 6 of 7, and quoting 7 would overstate what was proven.
   *
   * It still earns its place. This change is what makes the field reachable — it
   * introduces a projection sourced from the same columns the justification text
   * lives beside, so "it was never there" stops being self-evidently permanent the
   * moment someone widens the select.
   */
  it('never carries the owner-authored justification text', () => {
    // `connectScopeJustifications` is an explicit non-goal of #555: publishing it is
    // a separate exposure decision. Pinning its ABSENCE from the DTO is what stops it
    // arriving later as an incidental passthrough.
    const detail = project({
      connectRequestedScopes: TokenScope.UserRead,
      connectScopeJustifications: { UserRead: 'we need your email to sign you in' },
    });
    // ⚠ No `not.toHaveProperty('connectScopeJustifications')` here — the exact-key-set
    // ledger in `app-listing.service.test.ts` already asserts the DTO's whole key set,
    // which subsumes it. This assertion is NOT subsumed: it also catches the text
    // arriving embedded inside a key the ledger permits. Narrowed on the audit's D4.
    expect(JSON.stringify(detail)).not.toContain('we need your email');
  });
});
