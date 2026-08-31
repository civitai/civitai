import { describe, expect, it } from 'vitest';
import { baseTypePrefersCaptions } from '~/utils/training';

describe('baseTypePrefersCaptions', () => {
  it('classifies only the legacy kohya SD1.5/SDXL base types as tag-based', () => {
    expect(baseTypePrefersCaptions('sd15')).toBe(false);
    expect(baseTypePrefersCaptions('sdxl')).toBe(false);
  });

  it('classifies AI-Toolkit, video, and audio base types as caption-based', () => {
    // These were all absent from the old hand-maintained `prefersCaptions` allowlist and
    // therefore showed the inverted alert — the regression this change fixes.
    for (const baseType of [
      'krea2',
      'flux',
      'qwen',
      'anima',
      'boogu',
      'mageflow',
      'ideogram4',
      'wan',
      'ltx25',
      'minimaxh3',
      'acestep15',
    ] as const) {
      expect(baseTypePrefersCaptions(baseType)).toBe(true);
    }
  });
});
