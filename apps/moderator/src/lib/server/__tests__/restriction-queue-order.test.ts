import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured);
  return { dbRead: db, dbWrite: db };
});

const { getGenerationRestrictions } = await import('../user-restriction.service');

const orderBy = async (status?: 'Pending' | 'Upheld' | 'Overturned') => {
  captured.length = 0;
  await getGenerationRestrictions({ page: 1, limit: 20, status });
  const list = captured.find((s) => s.includes(' order by '));
  if (!list) throw new Error('the restriction list emitted no ordered query');
  return list.slice(list.indexOf(' order by '));
};

describe('generation restriction queue order', () => {
  // 🔴 A Pending row keeps its account muted until someone rules on it. Newest first left 288 accounts
  // muted for over a month on the last pages (2026-10-07). Do not flip this back to match the history
  // views below.
  it('pending mutes are worked oldest first', async () => {
    expect(await orderBy('Pending')).toMatch(
      /^ order by "ur"\."createdAt" asc, "ur"\."id" asc limit/
    );
  });

  it.each([undefined, 'Upheld', 'Overturned'] as const)(
    'a history view (status %s) reads newest first',
    async (status) => {
      expect(await orderBy(status)).toMatch(
        /^ order by "ur"\."createdAt" desc, "ur"\."id" desc limit/
      );
    }
  );
});
