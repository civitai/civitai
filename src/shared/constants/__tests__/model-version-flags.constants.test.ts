import { describe, expect, it } from 'vitest';
import {
  getModelVersionFlagLabels,
  ModelVersionFlag,
  modelVersionFlagLabels,
} from '~/shared/constants/model-version-flags.constants';

describe('ModelVersionFlag', () => {
  // These values are written by hand-applied SQL (NotEvictable: the 20260930190000 migration) and
  // hardcoded in event-engine-common (GenerationDisabled). Renumbering one silently repoints every
  // row that already carries it.
  it('keeps the stored bit values that SQL and event-engine-common depend on', () => {
    expect(ModelVersionFlag.GenerationDisabled).toBe(2);
    expect(ModelVersionFlag.NotDerivative).toBe(4);
    expect(ModelVersionFlag.NotEvictable).toBe(8);
  });

  it('gives every flag its own single bit, never the retired bit 1', () => {
    const bits = Object.values(ModelVersionFlag).filter((v) => v !== ModelVersionFlag.None);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) expect(bit & (bit - 1), `flag ${bit} is not a single bit`).toBe(0);
    expect(bits).not.toContain(1);
  });

  it('has a label for every flag', () => {
    const flags = Object.values(ModelVersionFlag).filter((v) => v !== ModelVersionFlag.None);
    for (const flag of flags) expect(modelVersionFlagLabels[flag], `flag ${flag}`).toBeTruthy();
    expect(getModelVersionFlagLabels(ModelVersionFlag.NotEvictable)).toEqual(['Not evictable']);
  });
});
