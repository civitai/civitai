import { describe, expect, it } from 'vitest';
import {
  legacyImageSearchDestination,
  offersImageSearch,
  resolveSearchTarget,
  feedSearchPathname,
  pageSearchFor,
  isProfileFeedPathname,
  searchSectionFromPath,
  profileFeedSection,
  searchesFeedInPlace,
  searchSectionFor,
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
    expect(searchesFeedInPlace(feedOnly, 'images', '/images')).toBe(true);
    const searchPagesOnly = { imageSearch: true, feedSearch: false };
    expect(searchesFeedInPlace(searchPagesOnly, 'images', '/images')).toBe(false);
    expect(searchesFeedInPlace(feedOnly, 'images', '/models')).toBe(false);
    expect(searchesFeedInPlace(feedOnly, 'models', '/images')).toBe(false);
  });

  it('searches the models feed in place under its own flag, and only on /models', () => {
    const modelsOnly = { modelFeedSearch: true };
    expect(searchesFeedInPlace(modelsOnly, 'models', '/models')).toBe(true);
    expect(searchesFeedInPlace(feedOnly, 'models', '/models')).toBe(false);
    expect(searchesFeedInPlace(modelsOnly, 'images', '/images')).toBe(false);
    expect(feedSearchPathname(modelsOnly, 'models')).toBe('/models');
    expect(feedSearchPathname(modelsOnly, 'articles')).toBeUndefined();
  });

  it('searches the articles feed in place under its own flag, and only on /articles', () => {
    const articlesOnly = { articleFeedSearch: true };
    expect(searchesFeedInPlace(articlesOnly, 'articles', '/articles')).toBe(true);
    expect(searchesFeedInPlace({ modelFeedSearch: true }, 'articles', '/articles')).toBe(false);
    expect(searchesFeedInPlace(articlesOnly, 'articles', '/models')).toBe(false);
    expect(feedSearchPathname(articlesOnly, 'articles')).toBe('/articles');
  });

  it('filters /services in place under its own flag, only from the default target', () => {
    const servicesOnly = { servicesFeedSearch: true };
    expect(searchesFeedInPlace(servicesOnly, 'models', '/services')).toBe(true);
    expect(searchesFeedInPlace({ modelFeedSearch: true }, 'models', '/services')).toBe(false);
    // An explicit pick of another index still searches that index.
    expect(searchesFeedInPlace(servicesOnly, 'users', '/services')).toBe(false);
    expect(searchesFeedInPlace(servicesOnly, 'models', '/models')).toBe(false);
  });

  it("filters a creator's profile tab in place under that feed's flag, but never lands there", () => {
    const all = { feedSearch: true, modelFeedSearch: true, articleFeedSearch: true };
    expect(searchesFeedInPlace(all, 'models', '/user/[username]/models')).toBe(true);
    expect(searchesFeedInPlace(all, 'images', '/user/[username]/images')).toBe(true);
    expect(searchesFeedInPlace(all, 'articles', '/user/[username]/articles')).toBe(true);
    expect(searchesFeedInPlace(feedOnly, 'models', '/user/[username]/models')).toBe(false);
    expect(searchesFeedInPlace(all, 'models', '/user/[username]/images')).toBe(false);
    expect(searchesFeedInPlace(all, 'models', '/user/[username]')).toBe(false);
    expect(feedSearchPathname(all, 'models')).toBe('/models');
  });

  it("opens the search page from a profile section that isn't the searchable feed", () => {
    const all = { feedSearch: true, modelFeedSearch: true, articleFeedSearch: true };
    expect(searchesFeedInPlace(all, 'models', '/user/[username]/models', 'published')).toBe(true);
    expect(searchesFeedInPlace(all, 'images', '/user/[username]/images', 'images')).toBe(true);
    expect(searchesFeedInPlace(all, 'images', '/user/[username]/images', 'reactions')).toBe(false);
    expect(searchesFeedInPlace(all, 'models', '/user/[username]/models', 'private')).toBe(false);
    expect(searchesFeedInPlace(all, 'articles', '/user/[username]/articles', 'draft')).toBe(false);
    // The main feeds have no sections.
    expect(searchesFeedInPlace(all, 'models', '/models', 'private')).toBe(true);
  });

  it("ignores a visitor's ?section= the way the profile pages do", () => {
    const query = { username: 'RisingV', section: 'draft' };
    expect(profileFeedSection(query, 'risingv')).toBe('draft');
    expect(profileFeedSection(query, 'someone')).toBeUndefined();
    expect(profileFeedSection(query, undefined)).toBeUndefined();
  });

  it('sends /search/images to the feed under feedSearch, even without imageSearch', () => {
    expect(legacyImageSearchDestination(feedOnly)).toBe('images-feed');
    expect(legacyImageSearchDestination({ imageSearch: true, feedSearch: true })).toBe(
      'images-feed'
    );
    expect(legacyImageSearchDestination({ imageSearch: true, feedSearch: false })).toBeUndefined();
    expect(legacyImageSearchDestination(neither)).toBe('models-search');
  });
});

describe('isProfileFeedPathname', () => {
  it("is true only on a creator's searchable profile tabs", () => {
    expect(isProfileFeedPathname('/user/[username]/models')).toBe(true);
    expect(isProfileFeedPathname('/user/[username]/videos')).toBe(false);
    expect(isProfileFeedPathname('/models')).toBe(false);
  });
});

describe('searchSectionFromPath', () => {
  it("follows the profile tab on a creator's profile, and the first segment elsewhere", () => {
    expect(searchSectionFromPath('/user/RisingV/models')).toBe('models');
    expect(searchSectionFromPath('/user/RisingV/images?sort=Newest')).toBe('images');
    expect(searchSectionFromPath('/user/RisingV')).toBe('user');
    expect(searchSectionFromPath('/user/RisingV/collections')).toBe('user');
    expect(searchSectionFromPath('/user/RisingV/posts')).toBe('user');
    expect(searchSectionFromPath('/articles/123/slug')).toBe('articles');
    expect(searchSectionFromPath('/')).toBeUndefined();
  });
});

describe('pageSearchFor', () => {
  it("gives a page that searches its own content the header bar, under that page's flag", () => {
    expect(pageSearchFor({ semanticChallengeSearch: true }, '/challenges')).toEqual({
      placeholder: 'Search challenges',
    });
    expect(pageSearchFor({ pageSearch: true }, '/shop')).toEqual({
      placeholder: 'Search the shop',
    });
  });

  it("searches a creator's posts and collections tabs by their route pattern", () => {
    expect(pageSearchFor({ pageSearch: true }, '/user/[username]/posts')).toEqual({
      placeholder: 'Search their posts',
    });
    expect(pageSearchFor({ pageSearch: true }, '/user/[username]/collections')).toEqual({
      placeholder: 'Search their collections',
    });
  });

  it('leaves the index search everywhere else, and on a page whose flag is off', () => {
    expect(pageSearchFor({ pageSearch: true }, '/models')).toBeUndefined();
    expect(pageSearchFor({}, '/shop')).toBeUndefined();
    expect(pageSearchFor({ pageSearch: true }, '/challenges')).toBeUndefined();
  });
});

describe('the bounties feed search', () => {
  it('searches /bounties in place under semanticBountySearch, with no profile tab', () => {
    const bountiesOnly = { semanticBountySearch: true };
    expect(searchesFeedInPlace(bountiesOnly, 'bounties', '/bounties')).toBe(true);
    expect(searchesFeedInPlace({}, 'bounties', '/bounties')).toBe(false);
    expect(feedSearchPathname(bountiesOnly, 'bounties')).toBe('/bounties');
  });
});

// /videos is the images feed's videos, so the images index searches it, under its own flag.
describe('the videos feed search', () => {
  const both = { feedSearch: true, videoFeedSearch: true };

  it('filters /videos in place from the images index only with both flags', () => {
    expect(searchesFeedInPlace(both, 'images', '/videos')).toBe(true);
    expect(searchesFeedInPlace(both, 'models', '/videos')).toBe(false);
    expect(searchesFeedInPlace({ feedSearch: true }, 'images', '/videos')).toBe(false);
    expect(searchesFeedInPlace({ videoFeedSearch: true }, 'images', '/videos')).toBe(false);
  });

  it('points the header bar at images on /videos, and leaves other sections alone', () => {
    expect(searchSectionFor('/videos', both)).toBe('images');
    expect(searchSectionFor('/videos', { feedSearch: true })).toBe('videos');
    expect(searchSectionFor('/models', both)).toBe('models');
  });
});

describe('page search on tools and downloads', () => {
  it('gives /tools and /user/downloads the header bar under pageSearch', () => {
    expect(pageSearchFor({ pageSearch: true }, '/tools')).toEqual({ placeholder: 'Search tools' });
    expect(pageSearchFor({ pageSearch: true }, '/user/downloads')).toEqual({
      placeholder: 'Search your downloads',
    });
    expect(pageSearchFor({}, '/tools')).toBeUndefined();
  });
});
