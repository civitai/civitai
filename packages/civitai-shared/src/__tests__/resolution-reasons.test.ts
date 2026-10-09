import { describe, expect, it } from 'vitest';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_REASONS,
  resolutionReasonError,
  resolutionReasonLabel,
  type ResolutionReason,
} from '../resolution-reasons';

const lists = Object.entries(RESOLUTION_REASONS).flatMap(([subject, verdicts]) =>
  Object.entries(verdicts).map(([verdict, reasons]) => ({
    subject,
    verdict,
    reasons: reasons as readonly ResolutionReason[],
  }))
);

describe('RESOLUTION_REASONS', () => {
  it.each(lists)('$subject/$verdict offers Other and no duplicate slug', ({ reasons }) => {
    const values = reasons.map((r) => r.value);
    expect(values).toContain('other');
    expect(new Set(values).size).toBe(values.length);
  });

  // This is the list moderation agreed to. Changing it is a moderation decision, not a code cleanup:
  // there is no remix/template/enhancer reason because moderators cannot see a prompt's origin, no
  // "nothing new" reject reason because moderation found it meaningless, and minor-age misreads are
  // split from keyword hits because they are most of the overturns.
  it('offers exactly the reasons moderation agreed to', () => {
    const offered = Object.fromEntries(
      lists.map(({ subject, verdict, reasons }) => [
        `${subject}/${verdict}`,
        reasons.map((r) => r.value),
      ])
    );
    expect(offered).toEqual({
      'restriction/Overturned': [
        'minor-term-misread',
        'word-match',
        'art-context',
        'isolated',
        'other',
      ],
      'restriction/Upheld': ['clear-intent', 'repeat-evasion', 'prior-history', 'other'],
      'appeal/Approved': ['misclassified', 'rating-only', 'context-provided', 'other'],
      'appeal/Rejected': ['violation-confirmed', 'different-violation', 'other'],
    });
  });

  // A slug that means different things under two verdicts of one subject would make the stored
  // column ambiguous once read without its status.
  it('gives each non-Other slug one meaning across the whole list', () => {
    const labels = new Map<string, string>();
    for (const { reasons } of lists)
      for (const r of reasons) {
        if (r.value === 'other') continue;
        expect(labels.get(r.value) ?? r.label, r.value).toBe(r.label);
        labels.set(r.value, r.label);
      }
  });
});

describe('resolutionReasonError', () => {
  it('accepts a reason that belongs to the verdict', () => {
    expect(resolutionReasonError('restriction', 'Overturned', 'word-match', undefined)).toBeNull();
    expect(resolutionReasonError('appeal', 'Rejected', 'different-violation', '')).toBeNull();
  });

  it('requires a reason', () => {
    expect(resolutionReasonError('appeal', 'Approved', undefined, 'note')).toMatch(/Pick a reason/);
    expect(resolutionReasonError('appeal', 'Approved', '', 'note')).toMatch(/Pick a reason/);
  });

  it('refuses a reason from the other verdict or the other subject', () => {
    expect(resolutionReasonError('restriction', 'Overturned', 'clear-intent', undefined)).toMatch(
      /not a reason for Overturned/
    );
    expect(
      resolutionReasonError('restriction', 'Upheld', 'violation-confirmed', undefined)
    ).toMatch(/not a reason for Upheld/);
  });

  it('requires a note for Other', () => {
    expect(resolutionReasonError('restriction', 'Upheld', 'other', '   ')).toMatch(/note/);
    expect(resolutionReasonError('restriction', 'Upheld', 'other', 'alt account')).toBeNull();
  });

  it('caps the note', () => {
    const long = 'x'.repeat(RESOLUTION_NOTE_MAX_LENGTH + 1);
    expect(resolutionReasonError('appeal', 'Approved', 'misclassified', long)).toMatch(/longer/);
  });
});

describe('resolutionReasonLabel', () => {
  it('labels a known slug and passes an unknown one through', () => {
    expect(resolutionReasonLabel('word-match')).toBe('Keyword hit only');
    expect(resolutionReasonLabel('retired-slug')).toBe('retired-slug');
    expect(resolutionReasonLabel(null)).toBeNull();
  });
});
