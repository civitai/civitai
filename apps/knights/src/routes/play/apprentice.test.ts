import { describe, expect, it } from 'vitest';
import { explanationOf } from './apprentice';

describe('explanationOf a missed apprenticeship item', () => {
  it('keeps an explanation the item carries', () => {
    expect(explanationOf({ kind: 'rating', correctLabel: 'R', explanation: 'Because.' })).toBe(
      'Because.'
    );
  });

  it("falls back to the correct rating's own definition from the rating guide", () => {
    const line = explanationOf({ kind: 'rating', correctLabel: 'R', explanation: null });
    expect(line).toMatch(/^R: .{10,}/);
  });

  it('never leaves a blank, for a rating the guide does not know or a yes/no answer', () => {
    expect(explanationOf({ kind: 'rating', correctLabel: 'Z', explanation: null })).toBe(
      'Moderators rated this one Z.'
    );
    expect(explanationOf({ kind: 'yesno', correctLabel: 'No', explanation: null })).toBe(
      'Moderators answered No for this one.'
    );
  });
});
