import { describe, expect, it } from 'vitest';
import {
  RESTRICTION_DECISIONS,
  restrictionDecisionReasons,
  restrictionEffectiveReason,
  restrictionRulingRefusal,
} from '../ruling-decisions';

describe('RESTRICTION_DECISIONS', () => {
  it('puts uphold on key 1 and overturn on key 2', () => {
    expect(RESTRICTION_DECISIONS.map((d) => d.verdict)).toEqual(['Upheld', 'Overturned']);
  });
});

describe('restrictionDecisionReasons', () => {
  it('lists only the reasons that fit the verdict, each ending in Other', () => {
    const upheld = restrictionDecisionReasons('Upheld').map((r) => r.value);
    const overturned = restrictionDecisionReasons('Overturned').map((r) => r.value);
    expect(upheld).toContain('clear-intent');
    expect(upheld).not.toContain('word-match');
    expect(overturned).toContain('word-match');
    expect(upheld.at(-1)).toBe('other');
    expect(overturned.at(-1)).toBe('other');
  });
});

describe('restrictionRulingRefusal', () => {
  it('refuses a ruling with no reason', () => {
    expect(restrictionRulingRefusal('Upheld', '', '')).toBeTruthy();
  });

  it('accepts a specific reason without a note', () => {
    expect(restrictionRulingRefusal('Upheld', 'clear-intent', '')).toBeNull();
  });

  it('refuses Other without a note and accepts it with one', () => {
    expect(restrictionRulingRefusal('Overturned', 'other', '  ')).toBeTruthy();
    expect(restrictionRulingRefusal('Overturned', 'other', 'because')).toBeNull();
  });

  it('names a reason that belongs to the other verdict in words', () => {
    const refusal = restrictionRulingRefusal('Upheld', 'word-match', '');
    expect(refusal).toContain('Keyword hit only');
    expect(refusal).toContain('uphold mute');
  });
});

describe('restrictionEffectiveReason', () => {
  it('keeps the picked reason', () => {
    expect(restrictionEffectiveReason('Upheld', 'prior-history')).toBe('prior-history');
  });

  it('suggests nothing while the verdict has several specific reasons', () => {
    expect(restrictionEffectiveReason('Upheld', '')).toBe('');
  });
});
