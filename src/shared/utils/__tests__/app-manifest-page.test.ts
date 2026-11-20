import { describe, expect, it } from 'vitest';
import { manifestDeclaresPage } from '~/shared/utils/app-manifest-page';

describe('manifestDeclaresPage', () => {
  it('is true for a manifest with a page path', () => {
    expect(manifestDeclaresPage({ name: 'A', page: { path: '/', title: 'A' } })).toBe(true);
  });

  it.each([
    ['no manifest', undefined],
    ['no page', { name: 'A' }],
    ['a page that is not an object', { page: 'yes' }],
    ['a page without a path', { page: { title: 'A' } }],
    ['an empty path', { page: { path: '' } }],
    ['a path that is not a string', { page: { path: 1 } }],
  ])('is false for %s', (_label, manifest) => {
    expect(manifestDeclaresPage(manifest)).toBe(false);
  });
});
