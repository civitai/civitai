import { describe, expect, it } from 'vitest';
import { changedCosmeticId } from '~/components/Modals/profile-cosmetic-ids';

describe('changedCosmeticId', () => {
  it('sends nothing for a slot the save did not touch, worn or empty', () => {
    expect(changedCosmeticId(null, null)).toBeUndefined();
    expect(changedCosmeticId(undefined, null)).toBeUndefined();
    expect(changedCosmeticId({ id: 4 }, { id: 4 })).toBeUndefined();
  });

  it('sends null to take a worn one off, and the id to put one on or swap it', () => {
    expect(changedCosmeticId(null, { id: 4 })).toBeNull();
    expect(changedCosmeticId({ id: 4 }, null)).toBe(4);
    expect(changedCosmeticId({ id: 5 }, { id: 4 })).toBe(5);
  });
});
