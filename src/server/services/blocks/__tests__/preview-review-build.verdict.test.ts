import { describe, expect, it } from 'vitest';
import {
  budgetBlocksReviewBuild,
  reviewBuildTimeoutMessage,
  reviewBuildVerdict,
} from '../../../../../tests/preview-review-build';
import { reviewBuildFailureError } from '~/pages/api/internal/blocks/review-build-callback';
import { STORED_REVIEW_PREVIEW_STATES } from '~/shared/constants/app-review-preview.constants';

/**
 * How the preview e2e (`tests/preview-apps-publish.spec.ts`) reads the automatic review build of
 * its own submission. The spec runs only against a live preview, so its verdict logic is pinned
 * here, against the platform's own state names and failure text.
 */
describe('preview e2e: review-build verdict', () => {
  it('a build that reached deploying or live passed the manifest check', () => {
    expect(reviewBuildVerdict({ state: 'preview-deploying' })).toMatchObject({
      done: true,
      pass: true,
    });
    expect(reviewBuildVerdict({ state: 'preview-live' })).toMatchObject({ done: true, pass: true });
  });

  it('no preview yet, queued or building keeps polling', () => {
    for (const state of [null, 'preview-queued', 'preview-building']) {
      expect(reviewBuildVerdict({ state })).toEqual({ done: false });
    }
  });

  it('a build the manifest check rejected fails, naming the manifest check', () => {
    // The platform's own failure text for a validate-step failure, not a hand-written copy.
    const error = reviewBuildFailureError('Failed', 'validate', 'author');
    const v = reviewBuildVerdict({ state: 'preview-failed', detail: { error } });
    expect(v).toEqual({
      done: true,
      pass: false,
      message: `The review build REJECTED the manifest: ${error}`,
    });
  });

  it('a build that failed at a later step fails too, saying it was not the manifest check', () => {
    const error = reviewBuildFailureError('Failed', 'build', 'author');
    expect(reviewBuildVerdict({ state: 'preview-failed', detail: { error } })).toEqual({
      done: true,
      pass: false,
      message: `The review build failed (not at the manifest check): ${error}`,
    });
  });

  it('an expired preview fails', () => {
    expect(reviewBuildVerdict({ state: 'preview-expired' })).toMatchObject({
      done: true,
      pass: false,
    });
  });

  it('INVARIANT: every stored review-preview state is either polled on or decided', () => {
    // A state the platform adds later must be classified on purpose: today every one is known.
    const decided = STORED_REVIEW_PREVIEW_STATES.filter(
      (s) => reviewBuildVerdict({ state: s }).done
    );
    expect(decided).toEqual(['preview-deploying', 'preview-live', 'preview-failed']);
  });
});

describe('preview e2e: the automatic-build budget', () => {
  it('a spent budget blocks the build, and the message says the budget is spent', () => {
    expect(
      budgetBlocksReviewBuild(
        { available: true, scope: 'fixture-slug', limit: 10, remaining: 0 },
        'ci-smoke-pub-pr-1'
      )
    ).toBe(
      'The automatic review-build budget for ci-smoke-pub-pr-1 is spent for today ' +
        "(scope fixture-slug, limit 10/day): the submission's review build would not start, " +
        'so the manifest check was not exercised.'
    );
  });

  it('an unreadable budget blocks the build too', () => {
    expect(budgetBlocksReviewBuild({ available: false, scope: 'account' }, 'ci-x')).toMatch(
      /could not be read/
    );
  });

  it('CONTROL: one build left does not block', () => {
    expect(
      budgetBlocksReviewBuild(
        { available: true, scope: 'account', limit: 20, remaining: 1 },
        'ci-x'
      )
    ).toBeNull();
  });

  it('a timeout with no preview and a budget spent since the pre-read blames the budget', () => {
    const msg = reviewBuildTimeoutMessage({
      slug: 'ci-x',
      timeoutMs: 300_000,
      lastState: null,
      budgetAfter: { available: true, scope: 'account', limit: 20, remaining: 0 },
    });
    expect(msg).toMatch(/^No review-build verdict for ci-x within 300s \(last state: none\)\. /);
    expect(msg).toMatch(/budget for ci-x is spent for today/);
  });

  it('a timeout while building blames the queue, not the budget', () => {
    const msg = reviewBuildTimeoutMessage({
      slug: 'ci-x',
      timeoutMs: 300_000,
      lastState: 'preview-building',
      budgetAfter: { available: true, scope: 'account', limit: 20, remaining: 0 },
    });
    expect(msg).toMatch(/still queued or running/);
    expect(msg).not.toMatch(/budget/);
  });
});
