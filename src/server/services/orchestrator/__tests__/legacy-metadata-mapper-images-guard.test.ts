import { describe, expect, it } from 'vitest';
import { mapDataToGraphInput } from '../legacy-metadata-mapper';

/**
 * Regression for `generation.getGenerationData` → "e.images.map is not a function".
 *
 * `mapDataToGraphInput` shapes historic params into graph input. The `images`
 * field is *typed* as an array but can be a non-array in malformed/legacy stored
 * params; a bare `p.images.map(...)` then throws and the whole getGenerationData
 * call 500s. The fix only maps when `images` is actually an array.
 */
describe('mapDataToGraphInput — non-array images guard', () => {
  it('does not throw when params.images is a non-array object', () => {
    expect(() =>
      mapDataToGraphInput({ prompt: 'x', images: { 0: { url: 'u' } } as unknown }, [])
    ).not.toThrow();
  });

  it('does not throw when params.images is a string', () => {
    expect(() =>
      mapDataToGraphInput({ prompt: 'x', images: 'not-an-array' as unknown }, [])
    ).not.toThrow();
  });

  it('still maps a well-formed images array', () => {
    const out = mapDataToGraphInput(
      { prompt: 'x', images: [{ url: 'http://a/img.png', width: 64, height: 48 }] },
      []
    );
    expect(out.images).toEqual([{ url: 'http://a/img.png', width: 64, height: 48 }]);
  });

  it('leaves images undefined for a non-array (no partial/garbage mapping)', () => {
    const out = mapDataToGraphInput({ prompt: 'x', images: 123 as unknown }, []);
    expect(out.images).toBeUndefined();
  });
});
