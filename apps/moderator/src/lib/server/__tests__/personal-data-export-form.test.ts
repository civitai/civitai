import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { dashboardQueueSchema } = await import('../personal-data-export-form');
const { parseForm } = await import('../query');

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('dashboard queue form', () => {
  it('takes the date the moderator entered as the request date', () => {
    expect(
      parseForm(dashboardQueueSchema, form({ userId: '7', requestedAt: '2026-09-14' }))
    ).toEqual({ userId: 7, requestedAt: new Date('2026-09-14T00:00:00Z') });
  });

  it('refuses a missing date: there is no fallback to today', () => {
    const cases: Record<string, string>[] = [{ userId: '7' }, { userId: '7', requestedAt: '' }];
    for (const fields of cases)
      expect(parseForm(dashboardQueueSchema, form(fields))).toBe('Enter the date the user asked.');
  });

  it('refuses a date in the future', () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(parseForm(dashboardQueueSchema, form({ userId: '7', requestedAt: tomorrow }))).toBe(
      'The request date cannot be in the future.'
    );
  });
});
