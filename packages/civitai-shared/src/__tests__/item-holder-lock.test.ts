import { describe, expect, it } from 'vitest';
import { ITEM_HOLDER_LOCK_CLASS } from '../item-holder-lock';

describe('ITEM_HOLDER_LOCK_CLASS', () => {
  // Two apps deployed separately lock under it; a new number on one side is no exclusion at all
  // until the other ships.
  it('keeps its value', () => {
    expect(ITEM_HOLDER_LOCK_CLASS).toBe(1229455361);
  });
});
