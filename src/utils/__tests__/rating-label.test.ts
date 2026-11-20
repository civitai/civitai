import { describe, expect, it } from 'vitest';

import { ModelVersionReview } from '~/components/Model/ModelVersions/ModelVersionReview';
import { getRatingLabel, getRatingSummary } from '~/utils/rating-label';

describe('getRatingLabel — rating bands', () => {
  it('maps each rating band to its label and colour', () => {
    expect(getRatingLabel({ positiveRating: 0.19, totalCount: 3 })).toEqual({
      label: 'Mixed',
      color: 'yellow',
    });
    expect(getRatingLabel({ positiveRating: 0.2, totalCount: 3 })).toEqual({
      label: 'Mostly negative',
      color: 'orange',
    });
    expect(getRatingLabel({ positiveRating: 0.4, totalCount: 3 })).toEqual({
      label: 'Mixed',
      color: 'yellow',
    });
    expect(getRatingLabel({ positiveRating: 0.7, totalCount: 3 })).toEqual({
      label: 'Mostly Positive',
      color: 'lime',
    });
    expect(getRatingLabel({ positiveRating: 0.8, totalCount: 3 })).toEqual({
      label: 'Positive',
      color: 'green',
    });
  });

  it('colours the negative band red once it has 10 reviews, and opens the top label at exactly 0.95', () => {
    expect(getRatingLabel({ positiveRating: 0.05, totalCount: 23 })).toEqual({
      label: 'Negative',
      color: 'red',
    });
    expect(getRatingLabel({ positiveRating: 0.05, totalCount: 2011 })).toEqual({
      label: 'Overwhelmingly negative',
      color: 'red',
    });
    expect(getRatingLabel({ positiveRating: 0.95, totalCount: 2011 })).toEqual({
      label: 'Overwhelmingly Positive',
      color: 'green',
    });
  });
});

describe('getRatingSummary', () => {
  it('is null with no reviews, since there is no rating to label', () => {
    expect(getRatingSummary({ thumbsUp: 0, thumbsDown: 0 })).toBeNull();
  });

  it('labels the thumbs and floors the share, so one thumbs down never reads 100%', () => {
    // 599 / 600 = 99.83%: rounding would show 100%.
    expect(getRatingSummary({ thumbsUp: 599, thumbsDown: 1 })).toEqual({
      label: 'Overwhelmingly Positive',
      color: 'green',
      percent: 99,
      total: 600,
    });
    expect(getRatingSummary({ thumbsUp: 7, thumbsDown: 0 })).toMatchObject({
      label: 'Positive',
      percent: 100,
      total: 7,
    });
    // 7 / 8 = 87.5%: floors to 87, where rounding would show 88.
    expect(getRatingSummary({ thumbsUp: 7, thumbsDown: 1 })?.percent).toBe(87);
  });
});

/**
 * The COUNT thresholds asserted at their exact edges. Separate from the table above
 * on purpose: here the fixture values ARE the constants (that is the point of an edge
 * test), so they are kept away from the table whose whole discipline is avoiding them.
 */
describe('getRatingLabel — count-bucket edges', () => {
  it('the negative band widens at exactly 10 / 50 / 500', () => {
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 9 }).label).toBe('Mixed');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 10 }).label).toBe('Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 49 }).label).toBe('Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 50 }).label).toBe('Very Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 499 }).label).toBe('Very Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 500 }).label).toBe(
      'Overwhelmingly negative'
    );
  });

  it('the positive band widens at exactly 50, and only 500 + >=0.95 reaches the top', () => {
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 49 }).label).toBe('Positive');
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 50 }).label).toBe('Very Positive');
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 499 }).label).toBe('Very Positive');
    // 500 reviews but under 0.95 → still "Very Positive", NOT the top label.
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 500 }).label).toBe('Very Positive');
    // …and 0.97 at 499 is still not the top either: BOTH conditions are required.
    expect(getRatingLabel({ positiveRating: 0.97, totalCount: 499 }).label).toBe('Very Positive');
    expect(getRatingLabel({ positiveRating: 0.97, totalCount: 500 }).label).toBe(
      'Overwhelmingly Positive'
    );
  });
});

describe('ModelVersionReview', () => {
  function nodes(el: unknown): unknown[] {
    if (el == null || typeof el !== 'object') return [];
    if (Array.isArray(el)) return el.flatMap(nodes);
    const props = (el as { props?: Record<string, unknown> }).props;
    return [el, ...(props ? nodes(props.children) : [])];
  }

  function verdict(up: number, down: number): { label: string; color: unknown } {
    const tree = ModelVersionReview({
      modelId: 1,
      versionId: 2,
      thumbsUpCount: up,
      thumbsDownCount: down,
    });
    const hit = nodes(tree).find((n) => {
      const props = (n as { props?: Record<string, unknown> }).props;
      return (
        !!props &&
        typeof props.c === 'string' &&
        typeof props.children === 'string' &&
        props.tt === 'capitalize'
      );
    }) as { props: { c: string; children: string } };
    return { label: hit.props.children, color: hit.props.c };
  }

  it('labels a version from its own thumbs up and down', () => {
    expect(verdict(431, 68)).toEqual({ label: 'Very Positive', color: 'green' });
    expect(verdict(4, 133)).toEqual({ label: 'Very Negative', color: 'red' });
  });
});
