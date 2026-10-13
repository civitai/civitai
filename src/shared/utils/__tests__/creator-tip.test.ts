import { describe, expect, it } from 'vitest';
import { anyTipEligible, isCreatorTipEligible } from '~/shared/utils/creator-tip';
import { UserFlag } from '~/shared/constants/user-flags.constants';

describe('isCreatorTipEligible', () => {
  it('is true for an ordinary owner', () => {
    expect(isCreatorTipEligible({ ownerId: 5, ownerFlags: 0 })).toBe(true);
  });

  it('is false when the owner has DisablePayout', () => {
    expect(isCreatorTipEligible({ ownerId: 5, ownerFlags: UserFlag.DisablePayout })).toBe(false);
  });

  it('reads DisablePayout alongside other bits', () => {
    expect(
      isCreatorTipEligible({ ownerId: 5, ownerFlags: UserFlag.DisablePayout | (1 << 4) })
    ).toBe(false);
    expect(isCreatorTipEligible({ ownerId: 5, ownerFlags: 1 << 4 })).toBe(true);
  });

  it('is false for the system owner (-1)', () => {
    expect(isCreatorTipEligible({ ownerId: -1, ownerFlags: 0 })).toBe(false);
  });

  it('treats unknown owner flags as no flags', () => {
    expect(isCreatorTipEligible({ ownerId: 5, ownerFlags: null })).toBe(true);
    expect(isCreatorTipEligible({ ownerId: 5, ownerFlags: undefined })).toBe(true);
  });
});

describe('anyTipEligible', () => {
  it('is false with nothing selected', () => {
    expect(anyTipEligible([])).toBe(false);
  });

  it('is false when every resource is exempt', () => {
    expect(anyTipEligible([{ tipsEnabled: false }, { tipsEnabled: false }])).toBe(false);
  });

  it('is true when one resource is eligible', () => {
    expect(anyTipEligible([{ tipsEnabled: false }, { tipsEnabled: true }])).toBe(true);
  });

  it('counts a resource with unknown eligibility as eligible', () => {
    expect(anyTipEligible([{ tipsEnabled: false }, {}])).toBe(true);
  });
});
