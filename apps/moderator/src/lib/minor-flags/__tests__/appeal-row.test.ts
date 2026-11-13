import { describe, expect, it } from 'vitest';
import {
  ago,
  appealDecisionHint,
  clipList,
  sameFileAppealsText,
  modelRef,
  pastAppealsText,
  sameFileAppealBadge,
  shortHash,
  yearMonth,
} from '../appeal-row';

describe('pastAppealsText', () => {
  it('lists only the non-zero statuses', () => {
    expect(pastAppealsText({ approved: 1, rejected: 2, void: 0, pending: 0 })).toBe(
      '1 approved, 2 rejected'
    );
  });
  it('says none when there is no history', () => {
    expect(pastAppealsText({ approved: 0, rejected: 0, void: 0, pending: 0 })).toBe('none');
  });
});

describe('sameFileAppealsText', () => {
  it('lists rejections first and pluralises the count', () => {
    expect(sameFileAppealsText({ approved: 1, rejected: 2, void: 0, pending: 0 })).toBe(
      '3 appeals (2 rejected, 1 approved)'
    );
    expect(sameFileAppealsText({ approved: 0, rejected: 1, void: 0, pending: 0 })).toBe(
      '1 appeal (1 rejected)'
    );
  });
  it('is null when no other model with the file was appealed', () => {
    expect(sameFileAppealsText({ approved: 0, rejected: 0, void: 0, pending: 0 })).toBeNull();
  });
});

describe('sameFileAppealBadge', () => {
  it('counts every earlier appeal, open ones included, and hides at zero', () => {
    expect(sameFileAppealBadge({ approved: 1, rejected: 1, void: 0, pending: 1 })).toBe(
      'Same file appealed 3× on other models'
    );
    expect(sameFileAppealBadge({ approved: 0, rejected: 0, void: 0, pending: 0 })).toBeNull();
  });
});

describe('clipList', () => {
  it('reports the overflow', () => {
    expect(clipList([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(clipList([1], 3)).toEqual({ shown: [1], more: 0 });
  });
  it('counts the overflow against the full length when the list itself was capped', () => {
    expect(clipList([1, 2, 3, 4, 5], 3, 40)).toEqual({ shown: [1, 2, 3], more: 37 });
  });
});

describe('shortHash', () => {
  it('keeps the first four and last three characters', () => {
    expect(shortHash('9f3c0d1e2b7a21')).toBe('9f3c…a21');
  });
  it('leaves a hash too short to shorten as it is', () => {
    expect(shortHash('9f3ca21')).toBe('9f3ca21');
  });
});

describe('yearMonth', () => {
  it('formats a date as year and month', () => {
    expect(yearMonth('2025-11-04T10:00:00.000Z')).toBe('2025-11');
    expect(yearMonth(new Date('2024-03-31T12:00:00.000Z'))).toBe('2024-03');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  it('spaces the unit from the number, as the detail meta lines read', () => {
    expect(ago('2026-10-17T10:00:00Z', now)).toBe('2 d ago');
    expect(ago('2026-10-19T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-10-19T11:55:00Z', now)).toBe('5 m ago');
  });
});

describe('modelRef', () => {
  it('groups the digits in threes with narrow no-break spaces', () => {
    expect(modelRef(1284311)).toBe('#1\u202f284\u202f311');
    expect(modelRef(8030)).toBe('#8\u202f030');
    expect(modelRef(805)).toBe('#805');
  });
});

describe('appealDecisionHint', () => {
  const LABELLED =
    'Every decision here is stored as a labelled example for tuning the text-scan prompts.';
  const SETTLES = 'Ruling here also settles this model in Auto-flagged.';

  it('says a hash appeal on an applied auto-flag also settles it in Auto-flagged', () => {
    expect(appealDecisionHint({ hash: true, alsoInAutoFlagged: true, textScan: false })).toBe(
      SETTLES
    );
  });
  it('makes no labelled-example claim for a hash appeal with no text-scan verdict', () => {
    expect(
      appealDecisionHint({ hash: true, alsoInAutoFlagged: false, textScan: false })
    ).toBeUndefined();
  });
  it('keeps the labelled-example hint for a text-scan appeal', () => {
    expect(appealDecisionHint({ hash: false, alsoInAutoFlagged: true, textScan: true })).toBe(
      LABELLED
    );
  });
  it('joins both when a hash-flagged model also carries a text-scan verdict', () => {
    expect(appealDecisionHint({ hash: true, alsoInAutoFlagged: true, textScan: true })).toBe(
      `${SETTLES} ${LABELLED}`
    );
  });
});
