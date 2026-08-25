import { describe, expect, it } from 'vitest';
import { isSaleEligibleGate, saleEligibleSqlText } from '../monetization/sale-eligibility';

const permanent = (terms: unknown) => ({ timeframeDays: null, endsAt: null, terms });

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

  // `timeframeDays`, not `endsAt`: an unpublished timed gate also has a null endsAt, so endsAt cannot
  // tell a timed gate from a permanent one.
  it('rejects early access however it is priced', () => {
    expect(
      isSaleEligibleGate({ timeframeDays: 14, endsAt: null, terms: { download: { price: 500 } } })
    ).toBe(false);
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

// The SQL half of the same rule — it filters the picker's list, which pages, so `isSaleEligibleGate`
// cannot answer for it. Asserted as text because a predicate that silently stops constraining something
// still returns rows, and a list that is merely too WIDE is the bug being fixed rather than a red test.
describe('saleEligibleSqlText', () => {
  const text = saleEligibleSqlText('mv');

  it('constrains the gate to a permanent, still-open one on the aliased version', () => {
    expect(text).toContain('pa."entityId" = mv."id"');
    expect(text).toContain('pa."timeframeDays" is null');
    expect(text).toContain('pa."endsAt" is null or pa."endsAt" > now()');
  });

  it('requires a price on either chargeable tier', () => {
    expect(text).toContain(`(pa."terms"->'download'->>'price')::numeric > 0`);
    expect(text).toContain(`(pa."terms"->'generation'->>'price')::numeric > 0`);
  });

  // Without the type guard, `::numeric` over a non-numeric price hard-errors the whole query rather than
  // skipping the row — every creator's list 500s off one malformed gate. `int` would do the same to a
  // fractional price, which nothing on the write path rejects.
  it('guards the cast and does not narrow it to int', () => {
    expect(text).toContain(`jsonb_typeof(pa."terms"->'download'->'price') = 'number'`);
    expect(text).toContain(`jsonb_typeof(pa."terms"->'generation'->'price') = 'number'`);
    expect(text).not.toContain('::int');
  });
});
