import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// The helper being right protects nothing if the write doesn't use it. Both shipped bugs were exactly
// that — the policy was correct and the call site read a pre-strip copy — and no test in this repo
// exercises `upsertModelVersion`, so a revert of either line stays green above. Structural, and it fails
// on the omission itself; the same guard the Creator Studio bulk action needed for the same reason.
describe('upsertModelVersion consumes the policy result', () => {
  const source = () =>
    readFileSync(
      fileURLToPath(new URL('../model-version.service.ts', import.meta.url)),
      'utf8'
    ).slice(0, 40_000);

  it.each([
    // B-2: the goal is written on its own arm, so a gate-only strip leaves it funding nothing.
    ['donationGoal = policy.donationGoal', 'the donation goal must leave with the gate'],
    // B-1: reading the pre-strip fee here made every stripped version demand an affirmation it cannot give.
    ['policy.feeMonetizes', 'the affirmation gate must read the post-strip fee'],
  ])('uses `%s` — %s', (needle) => {
    expect(source()).toContain(needle);
  });

  it('no longer feeds the affirmation gate from the pre-strip fee', () => {
    expect(source()).not.toContain('monetizes: hasLicensingFee');
  });
});
