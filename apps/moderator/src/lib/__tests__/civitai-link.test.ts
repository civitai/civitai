import { describe, expect, it } from 'vitest';
import { toLinkBase } from '../civitai-link';

const RED = 'https://civitai.red';

describe('toLinkBase', () => {
  it('moves a main-site link onto the link base, keeping path, query and hash', () => {
    expect(toLinkBase('https://civitai.com/models/1?modelVersionId=2#reviews', RED)).toBe(
      'https://civitai.red/models/1?modelVersionId=2#reviews'
    );
    expect(toLinkBase('https://www.civitai.com/images/9', RED)).toBe('https://civitai.red/images/9');
  });

  it('leaves other services and look-alike hosts alone', () => {
    for (const href of [
      'https://image.civitai.com/abc/def/original=true/x.jpeg',
      'https://hq.civitai.com/t/1',
      'https://civitai.com.evil.example/models/1',
      'https://civitai.red/models/1',
      '/reports/image',
      'mailto:support@civitai.com',
    ])
      expect(toLinkBase(href, RED)).toBe(href);
  });
});
