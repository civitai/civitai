import { describe, expect, it } from 'vitest';

import { failedBuildSummary } from '~/components/Apps/unifiedReviewRow';

/** The moderator chip's failed-build summary: structured signals only, closed lists only. */
describe('failedBuildSummary', () => {
  it('names the step in product words and the class', () => {
    expect(failedBuildSummary({ failedStep: 'scan', failureClass: 'unknown' })).toBe(
      'security scan · unknown'
    );
    expect(failedBuildSummary({ failedStep: 'clone', failureClass: 'platform' })).toBe(
      'fetching the source · platform'
    );
  });

  it.each([
    null,
    undefined,
    { failedStep: null, failureClass: null },
    { failedStep: 'none', failureClass: 'unknown' },
    { failedStep: 'scan', failureClass: null },
    { failedStep: '<b>x</b>', failureClass: 'unknown' },
    { failedStep: 'scan', failureClass: 'Build None' },
  ])('says nothing for %j', (signals) => {
    expect(failedBuildSummary(signals)).toBeNull();
  });
});
