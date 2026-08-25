import { describe, expect, it } from 'vitest';
import {
  classifyGate,
  isSaleEligibleGate,
  saleEligibleSqlText,
} from '../monetization/sale-eligibility';

const permanent = (terms: unknown) => ({ timeframeDays: null, endsAt: null, terms });
const earlyAccess = (terms: unknown) => ({ timeframeDays: 14, endsAt: null, terms });

describe('isSaleEligibleGate', () => {
  it('accepts a permanent gate with a download price', () => {
    expect(isSaleEligibleGate(permanent({ download: { price: 500 } }))).toBe(true);
  });

  // A generation-only version carries no download tier, so reading only `download` would call every one
  // of them unsaleable.
  it('accepts a permanent gate priced on generation alone', () => {
    expect(isSaleEligibleGate(permanent({ generation: { price: 200, trialLimit: 0 } }))).toBe(true);
  });

  // The defect in CU 868kwp6cx. A sale over one of these is created, reports itself as covering the
  // version, and then discounts nothing anywhere — there is no price for discountedTerms to compose over.
  it('rejects a version with no gate at all', () => {
    expect(isSaleEligibleGate(null)).toBe(false);
  });

  it('rejects a permanent gate carrying no price', () => {
    expect(isSaleEligibleGate(permanent({ generation: { free: true } }))).toBe(false);
    expect(isSaleEligibleGate(permanent({ download: { price: 0 } }))).toBe(false);
    expect(isSaleEligibleGate(permanent(null))).toBe(false);
  });

  // `terms` is jsonb, so the type says nothing about what is in it. `'500' > 0` is true in JS, which
  // would make the picker (SQL, type-guarded) and the write (this) disagree about the same version.
  it('rejects a price that is not a number', () => {
    expect(isSaleEligibleGate(permanent({ download: { price: '500' } }))).toBe(false);
    expect(isSaleEligibleGate(permanent({ generation: { price: true } }))).toBe(false);
  });

  // gatePrices drops the generation tier wholesale when the grant is a free one, so a price beside
  // `free` is not chargeable. The SQL half has to agree, or the picker lists what the write skips.
  it('rejects a free generation grant even when it carries a price', () => {
    expect(isSaleEligibleGate(permanent({ generation: { free: true, price: 300 } }))).toBe(false);
  });

  // `timeframeDays`, not `endsAt`: an unpublished timed gate also has a null endsAt, so endsAt cannot
  // tell a timed gate from a permanent one.
  it('rejects early access however it is priced', () => {
    expect(isSaleEligibleGate(earlyAccess({ download: { price: 500 } }))).toBe(false);
    expect(
      isSaleEligibleGate({
        timeframeDays: 14,
        endsAt: new Date('2099-01-01'),
        terms: { download: { price: 500 } },
      })
    ).toBe(false);
  });

  it('rejects a gate whose window has closed', () => {
    expect(
      isSaleEligibleGate({
        timeframeDays: null,
        endsAt: new Date('2020-01-01'),
        terms: { download: { price: 500 } },
      })
    ).toBe(false);
  });
});

// The creator is told WHICH reason applies, and the two arms are one keystroke apart — swapping them
// leaves every count correct and every message wrong.
describe('classifyGate', () => {
  it('separates the two reasons a version is skipped', () => {
    expect(classifyGate(permanent({ download: { price: 500 } }))).toBe('eligible');
    expect(classifyGate(earlyAccess({ download: { price: 500 } }))).toBe('earlyAccess');
    expect(classifyGate(permanent({ download: { price: 0 } }))).toBe('unpriced');
    expect(classifyGate(null)).toBe('unpriced');
  });

  // An early-access gate that is ALSO unpriced is still early access — the creator's next move is
  // different for each, and "price it" is the wrong instruction for a timed window.
  it('calls an unpriced early-access gate early access', () => {
    expect(classifyGate(earlyAccess({ download: { price: 0 } }))).toBe('earlyAccess');
  });
});

// The SQL half filters the picker's list, which pages — `isSaleEligibleGate` cannot answer for it.
//
// Asserted as one whole string rather than as substrings, because the mutations that matter most are
// STRUCTURAL and leave every substring in place: `exists` → `not exists` inverts the list to exactly the
// versions a sale cannot discount, and `and (priced…)` → `or (priced…)` decouples the subquery from the
// version entirely. Both passed a `toContain`-based version of this test.
describe('saleEligibleSqlText', () => {
  it('emits exactly this predicate', () => {
    expect(saleEligibleSqlText('mv', 77)).toBe(
      `exists (select 1 from "PaidAccess" pa where pa."entityType" = 'ModelVersion' and pa."entityId" = mv."id" and pa."ownerId" = 77 and pa."timeframeDays" is null and (pa."endsAt" is null or pa."endsAt" > now()) and ((jsonb_typeof(pa."terms"->'download'->'price') = 'number' and (pa."terms"->'download'->>'price')::numeric > 0) or (not (pa."terms"->'generation' ? 'free') and (jsonb_typeof(pa."terms"->'generation'->'price') = 'number' and (pa."terms"->'generation'->>'price')::numeric > 0))))`
    );
  });

  it('scopes to the alias and the owner it is given', () => {
    const text = saleEligibleSqlText('v', 12);
    expect(text).toContain('pa."entityId" = v."id"');
    expect(text).toContain('pa."ownerId" = 12');
  });

  // The owner id is interpolated into raw SQL, so nothing downstream parameterises it.
  it('refuses an owner id that is not an integer', () => {
    expect(() => saleEligibleSqlText('mv', 1.5)).toThrow();
    expect(() => saleEligibleSqlText('mv', Number('abc'))).toThrow();
  });
});
