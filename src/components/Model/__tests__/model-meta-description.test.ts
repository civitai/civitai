import { describe, expect, it } from 'vitest';
import { buildModelMetaDescription } from '~/components/Model/model-meta-description';

const base = {
  name: 'Juggernaut XL',
  ecosystemName: 'SDXL',
  typeName: 'Checkpoint',
  creator: 'maker',
  downloads: 1_234_000,
  likes: 45_600,
};

describe('model meta description', () => {
  it('says what the model is and how it has done before the creator text, tags stripped', () => {
    expect(
      buildModelMetaDescription({
        ...base,
        description: '<p>Hey everyone!! Photoreal SDXL checkpoint. <a href="x">Discord</a></p>',
      })
    ).toBe(
      'Juggernaut XL is a SDXL Checkpoint by maker. 1.2m downloads, 45.6k likes. Hey everyone!! Photoreal SDXL checkpoint. Discord'
    );
  });

  it('drops the stats clause and the creator when there are none', () => {
    expect(
      buildModelMetaDescription({
        ...base,
        creator: undefined,
        downloads: 0,
        likes: null,
        description: '',
      })
    ).toBe('Juggernaut XL is a SDXL Checkpoint.');
  });

  it('keeps one stat on its own', () => {
    expect(buildModelMetaDescription({ ...base, downloads: 0, likes: 12, description: null })).toBe(
      'Juggernaut XL is a SDXL Checkpoint by maker. 12 likes.'
    );
  });

  it('cuts at a word under the snippet length', () => {
    const description = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const full = buildModelMetaDescription({ ...base, description: '' }) + ' ' + description;
    const out = buildModelMetaDescription({ ...base, description });
    expect(out.length).toBeLessThanOrEqual(155);
    expect(out.endsWith('...')).toBe(true);
    const kept = out.slice(0, -3);
    expect(full.startsWith(kept)).toBe(true);
    expect(full[kept.length]).toBe(' ');
  });
});
