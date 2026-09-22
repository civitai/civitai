import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));

const { getMinorHashMatchesForReview, getAutoFlaggedMinorModels } = await import(
  '../minor-hash.service'
);

const compile = async (fn: () => Promise<unknown>) => {
  captured.length = 0;
  await fn();
  expect(captured).toHaveLength(1);
  return captured[0];
};

describe('minor queue search', () => {
  it('matches a Pending row against ANY seed sharing its hash, not only the one reported', async () => {
    const statement = await compile(() =>
      getMinorHashMatchesForReview({ limit: 50, search: { modelOrUserId: 900 } })
    );
    expect(statement).toMatch(/EXISTS \(\s*SELECT 1 FROM minor_src s3/);
    expect(statement).not.toMatch(/"s"\."minorModelId" = \$/);
  });

  it('compares a username case-insensitively', async () => {
    const statement = await compile(() =>
      getAutoFlaggedMinorModels({ limit: 50, search: { username: 'Someone' } })
    );
    expect(statement).toContain('lower("u"."username") = lower($');
  });

  it('adds nothing but TRUE without a search', async () => {
    const statement = await compile(() => getAutoFlaggedMinorModels({ limit: 50 }));
    expect(statement).not.toContain('"u"."username"');
  });
});
