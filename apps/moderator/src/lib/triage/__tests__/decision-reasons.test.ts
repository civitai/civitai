import { describe, expect, it } from 'vitest';
import { resolutionReasonsFor } from '@civitai/shared/resolution-reasons';
import { decisionReasonOptions, decisionReasonProblem, suggestedReason } from '../decision-reasons';

const values = (reasons: readonly { value: string }[]) => reasons.map((r) => r.value);

describe('decisionReasonOptions', () => {
  it('lists each decision once and moves a reason every decision offers after the groups', () => {
    const options = decisionReasonOptions([
      { label: 'Keep flag', reasons: resolutionReasonsFor('flagReview', 'Kept', ['minor']) },
      { label: 'Lift flag', reasons: resolutionReasonsFor('flagReview', 'Lifted', ['minor']) },
    ]);
    expect(options.groups.map((g) => [g.label, values(g.reasons)])).toEqual([
      ['Keep flag', ['detection-correct']],
      ['Lift flag', ['not-a-minor', 'terms-misread']],
    ]);
    expect(values(options.shared)).toEqual(['other']);
  });
});

describe('suggestedReason', () => {
  it("preselects the decision's only specific reason, so confirming a flag is one key", () => {
    expect(suggestedReason(resolutionReasonsFor('flagReview', 'Kept'))).toBe('detection-correct');
    expect(suggestedReason(resolutionReasonsFor('flagAppeal', 'Rejected'))).toBe('flag-confirmed');
  });

  it('suggests nothing when the moderator has a real choice to make', () => {
    expect(suggestedReason(resolutionReasonsFor('flagAppeal', 'Approved'))).toBe('');
  });
});

describe('decisionReasonProblem', () => {
  const problem = (reason: string, note = '', verdict: 'Kept' | 'Lifted' = 'Lifted') =>
    decisionReasonProblem('flagReview', verdict, 'Lift flag', reason, note, ['minor']);

  it('asks for a reason when none is picked', () => {
    expect(problem('')).toBe('Pick a reason for this ruling.');
  });

  it('refuses a reason that belongs to the other decision, naming both', () => {
    expect(problem('detection-correct')).toBe(
      '"Detection correct" is not a reason to lift flag. Pick a reason that fits.'
    );
  });

  it('refuses a reason for the other flag', () => {
    expect(problem('not-a-real-person')).toBe('"Not a real person" does not apply to this flag.');
  });

  it('needs a note with Other', () => {
    expect(problem('other')).toBe('Add a note when the reason is Other.');
    expect(problem('other', 'adult cosplay set')).toBeNull();
  });

  it('accepts a reason that fits the decision', () => {
    expect(problem('not-a-minor')).toBeNull();
    expect(problem('detection-correct', '', 'Kept')).toBeNull();
  });
});
