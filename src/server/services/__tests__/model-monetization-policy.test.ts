import { describe, expect, it } from 'vitest';
import { applyModelMonetizationPolicy } from '~/server/services/model-monetization-policy';

const gate = { permanent: true as const, terms: { download: { price: 5000 } } };
const goal = { amount: 10_000 };
const monetization = { type: 'PaidAccess' };

const poi = { poi: true, availability: 'Public' };
const priv = { poi: false, availability: 'Private' };
const ordinary = { poi: false, availability: 'Public' };

describe('applyModelMonetizationPolicy', () => {
  it('leaves an ordinary public model alone', () => {
    const out = applyModelMonetizationPolicy(ordinary, {
      paidAccess: gate,
      donationGoal: goal,
      monetization,
      licensingFee: 8,
    });
    expect(out).toMatchObject({
      paidAccess: gate,
      donationGoal: goal,
      licensingFee: 8,
      clearFee: false,
      feeMonetizes: true,
    });
  });

  it('strips everything from a POI model', () => {
    const out = applyModelMonetizationPolicy(poi, {
      paidAccess: gate,
      donationGoal: goal,
      monetization,
      licensingFee: 8,
    });
    expect(out.paidAccess).toBeNull();
    expect(out.donationGoal).toBeNull();
    expect(out.monetization).toBeNull();
    expect(out.licensingFee).toBeNull();
    expect(out.clearFee).toBe(true);
  });

  // The goal is written on its own arm of the write, so dropping only the gate leaves a Buzz-collecting
  // surface funding the unlock of something that no longer exists.
  it('takes the donation goal with the gate on a private model, and keeps the fee', () => {
    const out = applyModelMonetizationPolicy(priv, {
      paidAccess: gate,
      donationGoal: goal,
      licensingFee: 8,
    });
    expect(out.paidAccess).toBeNull();
    expect(out.donationGoal).toBeNull();
    expect(out.licensingFee).toBe(8);
    expect(out.feeMonetizes).toBe(true);
  });

  // The blocker this helper exists for: the rights-affirmation gate reads `monetizes`, and a version
  // cannot affirm its way out of a charge that is being REMOVED. Reading the pre-strip fee here made
  // every POI version with a stored fee and no current affirmation unsavable — for a fee field the
  // editor no longer renders.
  it('reports a stripped fee as no longer monetizing', () => {
    const out = applyModelMonetizationPolicy(poi, { licensingFee: 8 });
    expect(out.feeMonetizes).toBe(false);
  });

  it('still reports a surviving fee as monetizing', () => {
    expect(applyModelMonetizationPolicy(ordinary, { licensingFee: 8 }).feeMonetizes).toBe(true);
    expect(applyModelMonetizationPolicy(ordinary, { licensingFee: 0 }).feeMonetizes).toBe(false);
  });

  // A partial write (a moderator review action) sends no fee at all. The columns must still be cleared on
  // a POI model, which is why `clearFee` is separate from the returned value.
  it('asks for the fee columns to be cleared even when no fee was submitted', () => {
    const out = applyModelMonetizationPolicy(poi, { paidAccess: gate });
    expect(out.clearFee).toBe(true);
    expect(out.feeMonetizes).toBe(false);
  });

  it('does not ask to clear the fee columns on a model that may charge', () => {
    expect(applyModelMonetizationPolicy(ordinary, {}).clearFee).toBe(false);
    expect(applyModelMonetizationPolicy(priv, {}).clearFee).toBe(false);
  });
});
