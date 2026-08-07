import { describe, expect, it } from 'vitest';
import { formatLicensingFee } from '~/utils/licensing-fee-display';

describe('formatLicensingFee', () => {
  // The whole point: a fractional stored fee must never reach the page as "0.1 / image".
  it('renders a fractional per-generation fee as a whole-number ratio', () => {
    expect(formatLicensingFee(0.1)).toBe('1 / 10 images');
    expect(formatLicensingFee(0.5)).toBe('5 / 10 images');
    expect(formatLicensingFee(0.01)).toBe('1 / 100 images');
  });

  it('keeps a whole fee on a denominator of one', () => {
    expect(formatLicensingFee(1)).toBe('1 / 1 image');
    expect(formatLicensingFee(3)).toBe('3 / 1 image');
    expect(formatLicensingFee(100)).toBe('100 / 1 image');
  });

  it('never emits a fractional buzz amount for any enforced cap', () => {
    for (const fee of [0.01, 0.1, 0.5, 1, 3, 5, 10, 100]) {
      expect(formatLicensingFee(fee)).not.toMatch(/\d\.\d/);
    }
  });

  it('names the unit after the base model media type', () => {
    expect(formatLicensingFee(0.1, 'WanVideo1_3B_T2V')).toBe('1 / 10 videos');
    expect(formatLicensingFee(1, 'WanVideo1_3B_T2V')).toBe('1 / 1 video');
    expect(formatLicensingFee(1, 'SDXL 1.0')).toBe('1 / 1 image');
  });

  it('falls back to images when the base model is unknown', () => {
    expect(formatLicensingFee(1, null)).toBe('1 / 1 image');
    expect(formatLicensingFee(1, undefined)).toBe('1 / 1 image');
  });
});
