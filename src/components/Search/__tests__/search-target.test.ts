import { describe, expect, it } from 'vitest';
import {
  legacyImageSearchDestination,
  offersImageSearch,
  resolveSearchTarget,
  searchesImagesFeedInPlace,
} from '~/components/Search/search-target';

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

describe('the feed search flag on its own', () => {
  const feedOnly = { imageSearch: false, feedSearch: true };
  const neither = { imageSearch: false, feedSearch: false };

  it('offers image search with either flag, and not without both', () => {
    expect(offersImageSearch(feedOnly)).toBe(true);
    expect(offersImageSearch({ imageSearch: true, feedSearch: false })).toBe(true);
    expect(offersImageSearch(neither)).toBe(false);
  });

  it('searches the images feed in place with feedSearch alone, and only on /images', () => {
    expect(searchesImagesFeedInPlace(feedOnly, 'images', '/images')).toBe(true);
    expect(
      searchesImagesFeedInPlace({ imageSearch: true, feedSearch: false }, 'images', '/images')
    ).toBe(false);
    expect(searchesImagesFeedInPlace(feedOnly, 'images', '/models')).toBe(false);
    expect(searchesImagesFeedInPlace(feedOnly, 'models', '/images')).toBe(false);
  });

  it('sends /search/images to the feed under feedSearch, even without imageSearch', () => {
    expect(legacyImageSearchDestination(feedOnly)).toBe('images-feed');
    expect(legacyImageSearchDestination({ imageSearch: true, feedSearch: false })).toBeUndefined();
    expect(legacyImageSearchDestination(neither)).toBe('models-search');
  });
});
