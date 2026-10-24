import { describe, expect, it } from 'vitest';
import { resolveSearchTarget } from '~/components/Search/search-target';

describe('resolveSearchTarget', () => {
  it('moves an Images default to Models while image search is off', () => {
    expect(resolveSearchTarget('images', { imageSearch: false })).toBe('models');
  });

  it('keeps Images while image search is on', () => {
    expect(resolveSearchTarget('images', { imageSearch: true })).toBe('images');
  });

  // A non-Images, non-Models target, so a mutant that returns `'models'` unconditionally — or
  // ignores the target — cannot pass by producing the same literal the first case expects.
  it.each([true, false])('passes any other target through (imageSearch=%s)', (imageSearch) => {
    expect(resolveSearchTarget('articles', { imageSearch })).toBe('articles');
    expect(resolveSearchTarget('users', { imageSearch })).toBe('users');
  });

  it('substitutes Models only when the caller supports it', () => {
    expect(resolveSearchTarget('images', { imageSearch: false }, ['models', 'images'])).toBe(
      'models'
    );
    // A caller limited to Images keeps its own target (and so its maintenance notice) rather
    // than being moved onto an index it never declared.
    expect(resolveSearchTarget('images', { imageSearch: false }, ['images'])).toBe('images');
  });
});
