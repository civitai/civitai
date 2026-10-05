import { describe, expect, it } from 'vitest';
import { resolveMetaHref } from '~/components/Meta/canonical';

const BASE = 'https://civitai.com';

describe('resolveMetaHref', () => {
  it("prefixes a relative canonical with this deployment's base", () => {
    expect(resolveMetaHref('/tag/anime', BASE)).toBe('https://civitai.com/tag/anime');
  });

  it('leaves a cross-domain canonical alone', () => {
    expect(resolveMetaHref('https://civitai.green/tag/anime', BASE)).toBe(
      'https://civitai.green/tag/anime'
    );
  });

  it('never concatenates two absolute URLs', () => {
    expect(resolveMetaHref('http://civitai.green/tag/anime', BASE)).not.toContain(`${BASE}http`);
  });
});
