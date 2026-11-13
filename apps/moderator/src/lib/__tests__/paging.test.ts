import { describe, expect, it } from 'vitest';
import { selectionKey } from '$lib/paging';

const url = (s: string) => new URL(`https://mod.example${s}`);

describe('selectionKey', () => {
  it('is the same across an image page turn', () => {
    expect(selectionKey(url('/reports/user/1/images?tos=1&imgPage=3'))).toBe(
      selectionKey(url('/reports/user/1/images?tos=1'))
    );
  });

  it('changes with any other query param, and with the path', () => {
    const base = selectionKey(url('/reports/user/1/images?tos=1&imgPage=3'));
    expect(selectionKey(url('/reports/user/1/images?tos=1&page=2&imgPage=3'))).not.toBe(base);
    expect(selectionKey(url('/reports/user/1/images?imgPage=3'))).not.toBe(base);
    expect(selectionKey(url('/reports/user/1/details?tos=1'))).not.toBe(base);
  });
});
