import { describe, expect, it } from 'vitest';

import { safeInternalPath } from '~/utils/url-helpers';

const FALLBACK = '/posts/1';

describe('safeInternalPath', () => {
  it('keeps a same-origin path, query and hash included', () => {
    expect(safeInternalPath('/user/alice/posts?section=draft', FALLBACK)).toBe(
      '/user/alice/posts?section=draft'
    );
    expect(safeInternalPath('/user/account#accounts', FALLBACK)).toBe('/user/account#accounts');
  });

  it('collapses an absolute url to the fallback', () => {
    expect(safeInternalPath('https://evil.example/steal', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath('//evil.example/steal', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath('/\\evil.example/steal', FALLBACK)).toBe(FALLBACK);
  });

  it('collapses anything that is not a path-shaped string', () => {
    expect(safeInternalPath('evil.example', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath('', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(42, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(['/ok'], FALLBACK)).toBe(FALLBACK);
  });
});
