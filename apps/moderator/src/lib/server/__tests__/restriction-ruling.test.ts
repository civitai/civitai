import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { parseRestrictionRuling, rulingReason } = await import('../restriction-ruling');

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const parsed = (fields: Record<string, string>) => {
  const result = parseRestrictionRuling(form(fields));
  if (!result.ok) throw new Error(result.error);
  return result.input;
};

describe('parseRestrictionRuling', () => {
  it('refuses a verdict that is not Upheld or Overturned, and a bad restriction id', () => {
    expect(
      parseRestrictionRuling(form({ userRestrictionId: '5', status: 'Banned' }))
    ).toMatchObject({ ok: false });
    expect(
      parseRestrictionRuling(form({ userRestrictionId: '-1', status: 'Upheld' }))
    ).toMatchObject({ ok: false });
  });

  // The reason is checked after the caller's row checks, so a missing one must not fail the parse.
  it('accepts a ruling without a reason', () => {
    expect(
      parseRestrictionRuling(form({ userRestrictionId: '5', status: 'Overturned' }))
    ).toMatchObject({ ok: true, input: { userRestrictionId: 5, status: 'Overturned' } });
  });
});

describe('rulingReason', () => {
  it('returns the reason and the trimmed note', () => {
    expect(
      rulingReason(
        parsed({
          userRestrictionId: '5',
          status: 'Overturned',
          resolvedReason: 'remix-source',
          internalNotes: '  came from the remix  ',
        })
      )
    ).toEqual({ ok: true, resolvedReason: 'remix-source', internalNotes: 'came from the remix' });
  });

  it('refuses a ruling without a reason', () => {
    expect(rulingReason(parsed({ userRestrictionId: '5', status: 'Overturned' }))).toMatchObject({
      ok: false,
    });
  });
});
