import { describe, expect, it, vi } from 'vitest';
import {
  getModelReviewsCanonical,
  getModelReviewsRedirect,
  getModelReviewsVersionRedirect,
  getReviewsFilterInput,
  parseReviewsFilter,
  resolveReviewsVersion,
} from '~/components/ResourceReview/model-reviews-url';

describe('getModelReviewsCanonical', () => {
  it('omits the version param when no version is selected (was `?modelVersionId=undefined`)', () => {
    expect(getModelReviewsCanonical(4201)).toBe('/models/4201/reviews');
    expect(getModelReviewsCanonical(4201, undefined)).toBe('/models/4201/reviews');
    expect(getModelReviewsCanonical(4201, null)).toBe('/models/4201/reviews');
  });

  it('keeps the selected version', () => {
    expect(getModelReviewsCanonical(4201, 130072)).toBe(
      '/models/4201/reviews?modelVersionId=130072'
    );
  });
});

describe('getModelReviewsRedirect', () => {
  const MODEL = 4201;
  const VERSION = '130072';
  const CANONICAL = '/models/4201/reviews?modelVersionId=130072';

  it.each([
    ['plain listing', {}],
    ['version filter', { modelVersionId: VERSION }],
    ['paged listing', { modelVersionId: VERSION, page: '3' }],
    ['username filter', { username: 'someone' }],
    // A reload with an image opened inside the review dialog keeps what the user was viewing.
    [
      'nested dialogs',
      { modelVersionId: VERSION, dialog: ['resourceReview', 'imageDetail'], reviewId: '9' },
    ],
    ['an unrelated single dialog', { dialog: 'imageDetail', imageId: '5' }],
  ])('renders the %s', (_, query) => {
    expect(getModelReviewsRedirect(MODEL, query)).toBeNull();
  });

  it('redirects a single review dialog to the listing', () => {
    expect(
      getModelReviewsRedirect(MODEL, {
        modelVersionId: VERSION,
        dialog: 'resourceReview',
        reviewId: '9',
      })
    ).toBe(CANONICAL);
  });

  it('redirects a repeated review dialog', () => {
    expect(
      getModelReviewsRedirect(MODEL, {
        modelVersionId: VERSION,
        dialog: ['resourceReview', 'resourceReview', 'resourceReview'],
        reviewId: '9',
      })
    ).toBe(CANONICAL);
  });

  it('redirects a per-review URL with no dialog', () => {
    expect(getModelReviewsRedirect(MODEL, { modelVersionId: VERSION, reviewId: '9' })).toBe(
      CANONICAL
    );
  });

  it('redirects HTML-escaped `&amp;` params, reading the version through the escaping', () => {
    expect(
      getModelReviewsRedirect(MODEL, {
        'amp;modelVersionId': VERSION,
        'amp;amp;dialog': 'resourceReview',
        'amp;reviewId': '9',
      })
    ).toBe(CANONICAL);
  });

  it('redirects an escaped URL even when it carries only a version', () => {
    expect(getModelReviewsRedirect(MODEL, { 'amp;modelVersionId': VERSION })).toBe(CANONICAL);
  });

  it.each([['undefined'], ['0'], ['1.5'], ['abc']])(
    'redirects the malformed version param %s to the unfiltered listing',
    (modelVersionId) => {
      expect(getModelReviewsRedirect(MODEL, { modelVersionId })).toBe('/models/4201/reviews');
    }
  );

  it('carries a recognised filter through the redirect and drops an unrecognised one', () => {
    expect(
      getModelReviewsRedirect(MODEL, {
        modelVersionId: VERSION,
        dialog: 'resourceReview',
        filter: 'images',
      })
    ).toBe(`${CANONICAL}&filter=images`);
    expect(getModelReviewsRedirect(MODEL, { modelVersionId: 'abc', filter: 'down' })).toBe(
      '/models/4201/reviews?filter=down'
    );
    expect(
      getModelReviewsRedirect(MODEL, { 'amp;modelVersionId': VERSION, 'amp;filter': 'up' })
    ).toBe(`${CANONICAL}&filter=up`);
    expect(
      getModelReviewsRedirect(MODEL, { modelVersionId: VERSION, reviewId: '9', filter: 'bogus' })
    ).toBe(CANONICAL);
  });

  it('redirects a repeated version param to its first value', () => {
    expect(getModelReviewsRedirect(MODEL, { modelVersionId: [VERSION, '55'] })).toBe(CANONICAL);
  });
});

describe('the reviews page filter param', () => {
  it.each([
    ['images', 'images'],
    ['up', 'up'],
    ['down', 'down'],
    [['down', 'up'], 'down'],
  ] as const)('reads %j as %s', (value, filter) => {
    expect(parseReviewsFilter(value as string | string[])).toBe(filter);
  });

  it.each([[undefined], [''], ['all'], ['UP'], ['sideways']])(
    'reads %j as no filter, so the page lists everything',
    (value) => {
      expect(parseReviewsFilter(value)).toBeUndefined();
    }
  );

  it('maps each filter onto the getPaged inputs, and none onto no inputs', () => {
    expect(getReviewsFilterInput('images')).toEqual({ hasImages: true });
    expect(getReviewsFilterInput('up')).toEqual({ recommended: true });
    expect(getReviewsFilterInput('down')).toEqual({ recommended: false });
    expect(getReviewsFilterInput(undefined)).toEqual({});
  });
});

describe('getModelReviewsVersionRedirect', () => {
  it('points a versionless listing at the default version', () => {
    expect(getModelReviewsVersionRedirect(4201, {}, 130072)).toBe(
      '/models/4201/reviews?modelVersionId=130072'
    );
  });

  it('keeps the filter and drops the page, which belonged to another version', () => {
    expect(
      getModelReviewsVersionRedirect(4201, { filter: 'images', page: '4', id: '4201' }, 130072)
    ).toBe('/models/4201/reviews?modelVersionId=130072&filter=images');
  });

  it('drops an unrecognised filter', () => {
    expect(getModelReviewsVersionRedirect(4201, { filter: 'bogus' }, 130072)).toBe(
      '/models/4201/reviews?modelVersionId=130072'
    );
  });
});

describe('resolveReviewsVersion', () => {
  const FALLBACK = { id: 900 };

  it('renders a requested version the lookup confirmed, without loading the fallback', async () => {
    const loadFallback = vi.fn(async () => FALLBACK);
    await expect(
      resolveReviewsVersion({ modelVersionId: 5, requested: { id: 5 }, loadFallback })
    ).resolves.toEqual({ type: 'ok' });
    expect(loadFallback).not.toHaveBeenCalled();
  });

  it.each([
    ['no version requested', undefined, null],
    ['a version the model does not have', 5, null],
    ['a lookup that resolved to another version', 5, { id: 6 }],
  ])('redirects %s to the fallback version', async (_label, modelVersionId, requested) => {
    await expect(
      resolveReviewsVersion({ modelVersionId, requested, loadFallback: async () => FALLBACK })
    ).resolves.toEqual({ type: 'redirect', versionId: 900 });
  });

  it('is not found when the model has no published version to fall back to', async () => {
    await expect(
      resolveReviewsVersion({
        modelVersionId: undefined,
        requested: null,
        loadFallback: async () => null,
      })
    ).resolves.toEqual({ type: 'notFound' });
  });
});
