import { describe, expect, it } from 'vitest';
import {
  SEARCH_QUERY_MAX_CHARS,
  addDays,
  bisectDays,
  createdWithin,
  moderationQuery,
  statusQuery,
  unclassifiedQuery,
  type DayRange,
} from './queries';
import { TICKET_ROUTING } from './routing';

describe('Freshdesk search expressions', () => {
  it('stay within the length Freshdesk accepts', () => {
    for (const q of [moderationQuery(), unclassifiedQuery(), statusQuery(9000)])
      expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_CHARS);
  });

  it('the moderation query asks for every routing feature and status, and only live tickets', () => {
    const q = moderationQuery();
    for (const f of TICKET_ROUTING.moderationFeatures) expect(q).toContain(`cf_feature:'${f}'`);
    for (const s of TICKET_ROUTING.moderationStatuses) expect(q).toContain(`status:${s}`);
    expect(q).not.toMatch(/status:[45]\b/);
  });

  it('the unclassified query asks for a null cf_feature among live tickets', () => {
    expect(unclassifiedQuery()).toMatch(/^cf_feature:null AND \(status:2 OR /);
  });
});

describe('creation-day windows', () => {
  const days = (r: DayRange) => {
    const out: string[] = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const leaves = (r: DayRange): DayRange[] => {
    const halves = bisectDays(r);
    return halves ? halves.flatMap(leaves) : [r];
  };

  it('bisecting down to single days covers the range once, with no gap or overlap', () => {
    const range = { from: '2024-02-27', to: '2024-03-04' };
    expect(bisectDays(range)).toEqual([
      { from: '2024-02-27', to: '2024-03-01' },
      { from: '2024-03-02', to: '2024-03-04' },
    ]);
    expect(leaves(range).flatMap(days)).toEqual(days(range));
  });

  it('a single day cannot be split', () => {
    expect(bisectDays({ from: '2025-05-05', to: '2025-05-05' })).toBeNull();
  });

  it('writes the bounds one day outside the range, across month and year ends', () => {
    expect(createdWithin('status:2', { from: '2025-01-01', to: '2025-12-31' })).toBe(
      "(status:2) AND created_at:>'2024-12-31' AND created_at:<'2026-01-01'"
    );
  });

  it('parenthesises the expression so an OR cannot absorb the window', () => {
    expect(createdWithin('a:1 OR b:2', { from: '2025-01-10', to: '2025-01-12' })).toBe(
      "(a:1 OR b:2) AND created_at:>'2025-01-09' AND created_at:<'2025-01-13'"
    );
  });

  it('a windowed expression still fits the length Freshdesk accepts', () => {
    expect(
      createdWithin(moderationQuery(), { from: '2015-01-01', to: '2026-10-29' }).length
    ).toBeLessThanOrEqual(SEARCH_QUERY_MAX_CHARS);
  });
});
