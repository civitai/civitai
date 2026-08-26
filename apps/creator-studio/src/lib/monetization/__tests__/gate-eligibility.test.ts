import { describe, it, expect } from 'vitest';
import { pricingEligibility } from '@civitai/buzz';
import { resolveGateEligibility } from '../gate-eligibility';

const ELIGIBLE = pricingEligibility(50_000);
const BELOW_FLOOR = pricingEligibility(1_000);

const base = {
  selectedCount: 10,
  publishedCount: 0,
  maxEarlyAccessDays: 7,
  pricingSlotsLeft: 20,
  pricingFloor: ELIGIBLE,
  alreadyPriced: false,
  resolving: false,
};

describe('resolveGateEligibility', () => {
  it('offers timed when nothing in the selection is published', () => {
    const r = resolveGateEligibility(base);
    expect(r.canChooseTimed).toBe(true);
    expect(r.eligibleForTimed).toBe(10);
    expect(r.timedBlockedReason).toBeUndefined();
    expect(r.timedPartialNotice).toBeUndefined();
  });

  it('still offers timed for a partly-published selection, and reports the shortfall', () => {
    const r = resolveGateEligibility({ ...base, publishedCount: 4 });
    expect(r.canChooseTimed).toBe(true);
    expect(r.timedPartialNotice).toEqual({ skipped: 4, applies: 6 });
  });

  it('blocks timed when every selected version has been published', () => {
    const r = resolveGateEligibility({ ...base, publishedCount: 10 });
    expect(r.canChooseTimed).toBe(false);
    expect(r.eligibleForTimed).toBe(0);
    expect(r.timedBlockedReason).toMatch(/Every selected version has been published/);
    // No partial notice once it's blocked outright — the reason says it.
    expect(r.timedPartialNotice).toBeUndefined();
  });

  it('blocks timed while the publish count is still resolving', () => {
    const r = resolveGateEligibility({ ...base, resolving: true });
    expect(r.canChooseTimed).toBe(false);
    expect(r.timedBlockedReason).toMatch(/Checking/);
  });

  it('blocks timed when score has not unlocked early access, whatever the publish state', () => {
    const r = resolveGateEligibility({ ...base, maxEarlyAccessDays: 0 });
    expect(r.canChooseTimed).toBe(false);
    expect(r.timedBlockedReason).toMatch(/creator score/);
  });

  it('reports permanent as blocked only when no slots remain', () => {
    expect(resolveGateEligibility(base).canChoosePermanent).toBe(true);
    const full = resolveGateEligibility({ ...base, pricingSlotsLeft: 0 });
    expect(full.canChoosePermanent).toBe(false);
    expect(full.permBlocked).toBe(true);
  });

  it('speaks in the singular for a single version, which is how the sidebar uses it', () => {
    const r = resolveGateEligibility({ ...base, selectedCount: 1, publishedCount: 1 });
    expect(r.canChooseTimed).toBe(false);
    expect(r.timedBlockedReason).toMatch(/This version has been published/);
  });

  it('never reports negative eligibility if the counts disagree', () => {
    const r = resolveGateEligibility({ ...base, selectedCount: 3, publishedCount: 5 });
    expect(r.eligibleForTimed).toBe(0);
    expect(r.canChooseTimed).toBe(false);
  });
});

describe('the monetization floor', () => {
  it('blocks a permanent gate with a reason, even on a month full of unspent allowance', () => {
    const r = resolveGateEligibility({ ...base, pricingFloor: BELOW_FLOOR });
    expect(r.canChoosePermanent).toBe(false);
    expect(r.permBlocked).toBe(true);
    expect(r.permBlockedReason).toMatch(/creator score/);
  });

  // A timed window is not a price: it costs no slot and prices itself out when it closes. Blocking it
  // here would put early access behind a gate the write path does not apply.
  it('leaves early access alone', () => {
    const r = resolveGateEligibility({ ...base, pricingFloor: BELOW_FLOOR });
    expect(r.canChooseTimed).toBe(true);
    expect(r.timedBlockedReason).toBeUndefined();
  });

  it('does not apply to a selection that already carries a price', () => {
    const r = resolveGateEligibility({ ...base, pricingFloor: BELOW_FLOOR, alreadyPriced: true });
    expect(r.canChoosePermanent).toBe(true);
    expect(r.permBlockedReason).toBeUndefined();
  });

  // The two ways a permanent gate is refused have to stay distinguishable: the allowance case tells the
  // creator to deselect, which is useless advice to someone below the floor.
  it('is reported apart from a used-up allowance', () => {
    const full = resolveGateEligibility({ ...base, pricingSlotsLeft: 0 });
    expect(full.permBlocked).toBe(true);
    expect(full.permBlockedReason).toBeUndefined();
    expect(resolveGateEligibility(base).permBlockedReason).toBeUndefined();
  });
});
