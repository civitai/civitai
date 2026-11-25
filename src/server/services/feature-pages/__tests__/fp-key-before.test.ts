import { describe, expect, it } from 'vitest';
import { keyBefore, singleCommentQuery } from '~/server/services/feature-pages/mirror.service';

// The single read that confirms a lift pages from the key just before the comment's own.
describe('keyBefore', () => {
  const keys = [
    '3f9a0c1e7b2d4a6f8e0c1a2b3c4d5e6f',
    '3f9a0c1e7b2d4a6f8e0c1a2b3c4d5e70',
    '3f9a0c1e7b2d4a6f8e0c1a2b3c4d5e71',
    '3f9a0c1e7b2d4a6f8e0c1a2b3c4d5e00',
    '00000000000000000000000000000001',
  ].sort();

  it.each(keys)('the first platform key after keyBefore(%s) is that key', (key) => {
    const cursor = keyBefore(key);
    expect(cursor).toHaveLength(key.length);
    expect(keys.filter((k) => k > cursor)[0]).toBe(key);
  });

  it('the all-zero key pages from the start', () => {
    expect(keyBefore('0'.repeat(32))).toBe('');
  });

  it('borrows across zeros', () => {
    expect(keyBefore('ab00')).toBe('aaff');
    expect(keyBefore('a0')).toBe('9f');
  });

  it("the single read pages from just before the comment's own key", () => {
    const key = keys[1];
    const query = singleCommentQuery(`urn:data.civitai.com:feature-pages/comments/${key}`);
    expect(Object.fromEntries(query)).toEqual({
      app: 'feature-pages',
      limit: '1',
      cursor: keyBefore(key),
    });
    expect(keys.filter((k) => k > query.get('cursor')!)[0]).toBe(key);
  });
});
