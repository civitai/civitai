import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { parseRestrictionRuling } = await import('../restriction-ruling');

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('parseRestrictionRuling', () => {
  it('returns the ruling with the reason and the trimmed note', () => {
    expect(
      parseRestrictionRuling(
        form({
          userRestrictionId: '5',
          status: 'Overturned',
          resolvedReason: 'remix-source',
          internalNotes: '  came from the remix  ',
        })
      )
    ).toEqual({
      ok: true,
      userRestrictionId: 5,
      status: 'Overturned',
      resolvedReason: 'remix-source',
      internalNotes: 'came from the remix',
    });
  });

  it('refuses a verdict that is not Upheld or Overturned, and a bad restriction id', () => {
    expect(
      parseRestrictionRuling(form({ userRestrictionId: '5', status: 'Banned' }))
    ).toMatchObject({ ok: false });
    expect(
      parseRestrictionRuling(form({ userRestrictionId: '-1', status: 'Upheld' }))
    ).toMatchObject({ ok: false });
  });

  it('refuses a ruling without a reason', () => {
    expect(
      parseRestrictionRuling(form({ userRestrictionId: '5', status: 'Overturned' }))
    ).toMatchObject({ ok: false });
  });
});
