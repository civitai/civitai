// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from 'vitest';
import { lockedLicensingFeeRefusal } from './licensing-fee';

const stored = { fee: 0.25, type: 'PerImageBuzz', currency: 'Cash' };
const owner = (next: Parameters<typeof lockedLicensingFeeRefusal>[0]['next'], locked = true) =>
  lockedLicensingFeeRefusal({ isModerator: false, locked, stored, next });

describe('lockedLicensingFeeRefusal', () => {
  it.each([
    ['a new rate', { fee: 0.3, type: undefined, currency: undefined }],
    ['a cleared fee', { fee: null, type: undefined, currency: undefined }],
    ['a zero fee', { fee: 0, type: undefined, currency: undefined }],
    ['a new type', { fee: undefined, type: 'PercentOfCompute', currency: undefined }],
    ['a new currency', { fee: undefined, type: undefined, currency: 'Buzz' }],
  ])('refuses an owner sending %s', (_label, next) => {
    expect(owner(next)).toMatch(/set by Civitai/);
  });

  it('passes the stored values re-sent, and fields left out', () => {
    expect(owner({ fee: 0.25, type: 'PerImageBuzz', currency: 'Cash' })).toBeNull();
    expect(owner({ fee: undefined, type: undefined, currency: undefined })).toBeNull();
  });

  it('compares at the column precision, so a float round-trip is not a change', () => {
    const next = { fee: 0.1 + 0.2, type: undefined, currency: undefined };
    expect(next.fee).not.toBe(0.3);
    expect(
      lockedLicensingFeeRefusal({
        isModerator: false,
        locked: true,
        stored: { ...stored, fee: 0.3 },
        next,
      })
    ).toBeNull();
  });

  it('lets a moderator change it', () => {
    expect(
      lockedLicensingFeeRefusal({
        isModerator: true,
        locked: true,
        stored,
        next: { fee: 1, type: undefined, currency: undefined },
      })
    ).toBeNull();
  });

  it('does not apply while unlocked (control)', () => {
    expect(owner({ fee: 1, type: undefined, currency: undefined }, false)).toBeNull();
  });
});
