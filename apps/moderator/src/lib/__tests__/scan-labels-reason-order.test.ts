import { describe, expect, it } from 'vitest';
import { BLOCK_REASONS } from '$lib/scan-labels';

// Moderators pick a block reason by its number key. A reason added mid-list moves every key after it,
// so new reasons go last: do not reorder these to group related reasons.
describe('block reason number keys', () => {
  it('keeps every existing reason on its key, with csam-realistic added last', () => {
    expect(BLOCK_REASONS.map((r) => r.id)).toEqual([
      'minor-sexual',
      'minor-photoreal',
      'minor-violence',
      'real-person',
      'bestiality',
      'non-consent',
      'graphic-violence',
      'other',
      'csam-realistic',
    ]);
  });
});
