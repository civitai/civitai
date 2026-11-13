import { describe, expect, it } from 'vitest';
import { slugit, slugitOr } from '~/utils/string-helpers';

describe('slugitOr', () => {
  it('slugs an ASCII name as slugit does', () => {
    expect(slugitOr('My Comic!', 'comic')).toBe(slugit('My Comic!'));
    expect(slugitOr('My Comic!', 'comic')).toBe('my-comic');
  });

  it.each(['漫画', '第一章', '🔥', '', null, undefined])(
    'never returns an empty path segment for %s',
    (name) => {
      const slug = slugitOr(name, 'comic');
      expect(slug).toBe('comic');
      expect(`/comics/4471/${slug}/1/${slugitOr(name, 'chapter')}`).not.toContain('//');
    }
  );

  it('keeps the ASCII part of a mixed name', () => {
    expect(slugitOr('漫画 Hero', 'comic')).toBe('hero');
  });
});
