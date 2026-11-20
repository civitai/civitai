import { describe, expect, it } from 'vitest';
import { percentOfComputeFeeRefusal } from './licensing-fee';

// A percent fee is a share of every generation's compute cost, so who may set it, and how high, decides
// what users pay.
describe('percentOfComputeFeeRefusal', () => {
  const P = 'PercentOfCompute';
  const B = 'PerImageBuzz';
  const refused = (o: {
    isModerator?: boolean;
    requestedType?: string | null;
    storedType?: string | null;
    fee: number | null;
    storedFee?: number | null;
  }) =>
    percentOfComputeFeeRefusal({
      isModerator: false,
      requestedType: undefined,
      storedType: null,
      storedFee: null,
      ...o,
    });

  it('lets a moderator set one up to 100%', () => {
    expect(refused({ isModerator: true, requestedType: P, fee: 35 })).toBeNull();
    expect(refused({ isModerator: true, requestedType: P, fee: 100 })).toBeNull();
  });

  it('refuses a creator starting one', () => {
    expect(refused({ requestedType: P, fee: 35 })).toMatch(/restricted/);
  });

  it('refuses a creator turning a per-image fee into a percent by sending only the type', () => {
    expect(refused({ requestedType: P, storedType: B, fee: 5, storedFee: 5 })).toMatch(
      /restricted/
    );
  });

  it('lets an owner keep or lower the percent staff set, not raise it', () => {
    const stored = { storedType: P, storedFee: 35 };
    expect(refused({ ...stored, requestedType: P, fee: 35 })).toBeNull();
    expect(refused({ ...stored, fee: 30 })).toBeNull();
    expect(refused({ ...stored, requestedType: P, fee: 40 })).toMatch(/restricted/);
  });

  it('refuses an owner converting a staff percent to per-image, but lets them clear it', () => {
    const stored = { storedType: P, storedFee: 35 };
    expect(refused({ ...stored, requestedType: B, fee: 35 })).toMatch(/restricted/);
    expect(refused({ ...stored, requestedType: null, fee: null })).toBeNull();
  });

  it('leaves per-image fees alone', () => {
    expect(refused({ requestedType: B, storedType: B, fee: 500, storedFee: 5 })).toBeNull();
  });

  it('caps the percent for moderators too', () => {
    expect(refused({ isModerator: true, requestedType: P, fee: 101 })).toMatch(/at most 100%/);
  });
});
