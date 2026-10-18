import { describe, expect, it } from 'vitest';
import {
  getModelReviewsCanonical,
  getModelReviewsRedirect,
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

  it('redirects a repeated version param to its first value', () => {
    expect(getModelReviewsRedirect(MODEL, { modelVersionId: [VERSION, '55'] })).toBe(CANONICAL);
  });
});
