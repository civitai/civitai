import { describe, expect, it } from 'vitest';
import {
  TRAINING_REVIEW_COPY,
  TRAINING_REVIEW_RAISE_AFTER_HOURS,
  canRaiseTrainingReview,
  trainingHeldSince,
  trainingReviewPendingBody,
  trainingReviewState,
} from '../training-review';

const HOUR = 3_600_000;
const heldSince = '2026-11-09T10:00:00.000Z';
const after = (ms: number) => new Date(Date.parse(heldSince) + ms);

describe('canRaiseTrainingReview', () => {
  it('is not offered when the hold has just started', () => {
    expect(canRaiseTrainingReview(heldSince, after(0))).toBe(false);
  });

  it('is offered from the raise threshold on, and not a moment before', () => {
    const threshold = TRAINING_REVIEW_RAISE_AFTER_HOURS * HOUR;
    expect(canRaiseTrainingReview(heldSince, after(threshold - 1))).toBe(false);
    expect(canRaiseTrainingReview(heldSince, after(threshold))).toBe(true);
  });

  it('is offered after a day held, as the wait copy promises', () => {
    expect(canRaiseTrainingReview(heldSince, after(23 * HOUR))).toBe(false);
    expect(canRaiseTrainingReview(heldSince, after(24 * HOUR))).toBe(true);
  });

  it('counts real time, weekends included', () => {
    // Friday evening to Monday morning is well past any threshold under a week.
    expect(canRaiseTrainingReview('2026-11-06T20:00:00Z', new Date('2026-11-09T08:00:00Z'))).toBe(
      true
    );
  });

  it('is never offered for a missing or unreadable start', () => {
    const late = new Date('2027-01-01T00:00:00Z');
    expect(canRaiseTrainingReview(undefined, late)).toBe(false);
    expect(canRaiseTrainingReview('', late)).toBe(false);
    expect(canRaiseTrainingReview('not a date', late)).toBe(false);
  });
});

describe('trainingHeldSince', () => {
  it("prefers the step's start, then the workflow's creation", () => {
    expect(trainingHeldSince('2026-11-09T11:00:00Z', heldSince)).toBe('2026-11-09T11:00:00Z');
    expect(trainingHeldSince(null, heldSince)).toBe(heldSince);
    expect(trainingHeldSince(undefined, undefined)).toBeNull();
  });
});

describe('trainingReviewState', () => {
  it('reads both API spellings of a hold', () => {
    expect(trainingReviewState('underReview')).toBe('review');
    expect(trainingReviewState('UnderReview')).toBe('review');
  });

  it('reads a rejection, and nothing else', () => {
    expect(trainingReviewState('rejected')).toBe('rejected');
    expect(trainingReviewState('Rejected')).toBe('rejected');
    expect(trainingReviewState('approved')).toBeNull();
    expect(trainingReviewState('evaluating')).toBeNull();
    expect(trainingReviewState(undefined)).toBeNull();
  });
});

describe('trainingReviewPendingBody', () => {
  it('says "before it starts training" only while no checkpoint exists', () => {
    expect(trainingReviewPendingBody(0, 10)).toBe(TRAINING_REVIEW_COPY.pendingBody);
    expect(trainingReviewPendingBody(0, undefined)).toBe(TRAINING_REVIEW_COPY.pendingBody);
  });

  it('says training finished once every planned checkpoint exists', () => {
    expect(trainingReviewPendingBody(10, 10)).toBe(TRAINING_REVIEW_COPY.pendingFinishedBody);
    // Sparse epoch numbering can put the highest stored epoch past the plan (52 of 50).
    expect(trainingReviewPendingBody(11, 10)).toBe(TRAINING_REVIEW_COPY.pendingFinishedBody);
  });

  it('says partway when some checkpoints exist, or the plan is unknown', () => {
    expect(trainingReviewPendingBody(3, 10)).toBe(TRAINING_REVIEW_COPY.pendingPartwayBody);
    expect(trainingReviewPendingBody(3, null)).toBe(TRAINING_REVIEW_COPY.pendingPartwayBody);
  });
});
