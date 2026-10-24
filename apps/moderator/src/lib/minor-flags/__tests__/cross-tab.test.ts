import { describe, expect, it } from 'vitest';
import { crossTabChips } from '../cross-tab';

const APPEALS = '/models/flags/appeals';
const AUTO = '/models/flags/auto';
const NEEDS_REVIEW = '/models/flags/needs-review';

describe('crossTabChips', () => {
  it('names every other tab the model waits in, in tab order', () => {
    expect(
      crossTabChips({ needsReview: true, appeals: true, auto: true }, 7, [
        APPEALS,
        AUTO,
        NEEDS_REVIEW,
      ]).map((c) => c.label)
    ).toEqual(['also in Appeals', 'also in Auto-flagged', 'also in Needs review']);
  });

  it('links a chip to the model in that tab only when the viewer holds the tab', () => {
    expect(crossTabChips({ appeals: true, needsReview: true }, 7, [NEEDS_REVIEW])).toEqual([
      { label: 'also in Appeals', href: null, tone: 'amber' },
      { label: 'also in Needs review', href: `${NEEDS_REVIEW}?q=7`, tone: 'neutral' },
    ]);
  });

  it('shows nothing when the model waits nowhere else', () => {
    expect(crossTabChips({ appeals: false, auto: false }, 7, [APPEALS, AUTO])).toEqual([]);
  });
});
