import { describe, expect, it } from 'vitest';
import {
  allowsDifferentLicenseOnMerges,
  normalizeMergePermissions,
} from '~/server/common/constants';

describe('allowsDifferentLicenseOnMerges', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('merges %s, different %s -> %s', (allowDerivatives, allowDifferentLicense, expected) => {
    expect(allowsDifferentLicenseOnMerges({ allowDerivatives, allowDifferentLicense })).toBe(
      expected
    );
  });
});

describe('normalizeMergePermissions', () => {
  const run = (
    data: { allowDerivatives?: boolean; allowDifferentLicense?: boolean },
    stored?: boolean
  ) => {
    const copy = { ...data };
    normalizeMergePermissions(copy, stored);
    return copy;
  };

  it('stores "different permissions" off when the save turns merges off', () => {
    expect(run({ allowDerivatives: false, allowDifferentLicense: true }, true)).toEqual({
      allowDerivatives: false,
      allowDifferentLicense: false,
    });
  });

  it('covers a create, where nothing is stored yet', () => {
    expect(run({ allowDerivatives: false, allowDifferentLicense: true })).toEqual({
      allowDerivatives: false,
      allowDifferentLicense: false,
    });
  });

  it('turns it off when only allowDifferentLicense is sent to a model whose merges are off', () => {
    expect(run({ allowDifferentLicense: true }, false)).toEqual({ allowDifferentLicense: false });
  });

  it('control: keeps it on while merges are allowed', () => {
    expect(run({ allowDerivatives: true, allowDifferentLicense: true }, false)).toEqual({
      allowDerivatives: true,
      allowDifferentLicense: true,
    });
    expect(run({ allowDifferentLicense: true }, true)).toEqual({ allowDifferentLicense: true });
  });

  it('leaves a save that writes neither field alone, so a stored pair is never rewritten by it', () => {
    expect(run({}, false)).toEqual({});
  });
});
