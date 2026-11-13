import { describe, expect, it } from 'vitest';
import { BLOCK_REASONS, CSAM_HOLD_REASON } from '$lib/scan-labels';

// Moderators pick a block reason by its number key (1-9), so a reason's position is its key. New
// reasons go before csam-realistic, which stays past the keys; do not reorder the others.
describe('block reason number keys', () => {
  it('keeps the original eight reasons on keys 1-8 and school-nsfw on key 9', () => {
    expect(BLOCK_REASONS.map((r) => r.id).slice(0, 9)).toEqual([
      'minor-sexual',
      'minor-photoreal',
      'minor-violence',
      'real-person',
      'bestiality',
      'non-consent',
      'graphic-violence',
      'other',
      'school-nsfw',
    ]);
  });

  it('keeps csam-realistic past the number keys, so no single keystroke holds an image', () => {
    expect(BLOCK_REASONS.findIndex((r) => r.id === CSAM_HOLD_REASON)).toBeGreaterThanOrEqual(9);
  });
});
