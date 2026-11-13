import { describe, expect, it } from 'vitest';
import { buildInbox, type RulingSummary } from '../inbox';

const rows = Array.from({ length: 5 }, (_, i) => ({ groupKey: `g${i}` }));
const ruled = (ruling: RulingSummary['ruling']): RulingSummary => ({
  ruling,
  ruledBy: 1,
  ruledAt: new Date(0),
});

describe('buildInbox', () => {
  it('filters by state BEFORE paging — a ruled row on page 1 does not push an unruled one off', () => {
    const rulings = new Map([
      ['g0', ruled('correct')],
      ['g1', ruled('split')],
    ]);
    const out = buildInbox(rows, rulings, { state: 'unruled', page: 1, pageSize: 2 });
    expect(out.rows.map((r) => r.groupKey)).toEqual(['g2', 'g3']);
    expect(out.total).toBe(3);
  });

  it('escalate is its own state', () => {
    const out = buildInbox(rows, new Map([['g4', ruled('escalate')]]), {
      state: 'escalated',
      page: 1,
    });
    expect(out.rows.map((r) => [r.groupKey, r.state])).toEqual([['g4', 'escalated']]);
  });

  it('resolved is its own state, not "ruled"', () => {
    const rulings = new Map([
      ['g1', ruled('resolved')],
      ['g3', ruled('correct')],
    ]);
    expect(
      buildInbox(rows, rulings, { state: 'resolved', page: 1 }).rows.map((r) => r.groupKey)
    ).toEqual(['g1']);
    expect(
      buildInbox(rows, rulings, { state: 'ruled', page: 1 }).rows.map((r) => r.groupKey)
    ).toEqual(['g3']);
  });

  it('an unreadable store is unknown state, not "unruled", and the filter is not applied', () => {
    const out = buildInbox(rows, null, { state: 'unruled', page: 1 });
    expect(out.stateApplied).toBe(false);
    expect(out.total).toBe(5);
    expect(out.rows.every((r) => r.state === null)).toBe(true);
  });

  it('a page past the end lands on the last page', () => {
    const out = buildInbox(rows, new Map(), { state: 'all', page: 9, pageSize: 2 });
    expect(out.page).toBe(3);
    expect(out.rows.map((r) => r.groupKey)).toEqual(['g4']);
  });
});
