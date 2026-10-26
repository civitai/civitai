import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ sql: [] as string[], params: [] as unknown[][] }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured.sql, [], captured.params);
  return { dbRead: db, dbWrite: db };
});

vi.mock('/server', () => ({ getRequestEvent: () => ({ locals: {} }) }));

vi.mock('$app/server', () => ({ getRequestEvent: () => ({ locals: {} }) }));

const { restrictionTriageLoad } = await import('../restriction-queue');

const queue = { types: ['Prompt'], fallback: 'Prompt' } as never;

const load = async (query: string) => {
  captured.sql.length = 0;
  captured.params.length = 0;
  return restrictionTriageLoad(new URL(`http://x/audit/generator-restrictions${query}`), queue);
};

describe('restriction queue ?selected', () => {
  it('looks up an in-range id and reports it missing when no row matches', async () => {
    const data = await load('?selected=4040');
    expect(data.selectedMissing).toBe(4040);
    expect(captured.params.flat()).toContain(4040);
  });

  // 🔴 An id past int4 reached Postgres as an out-of-range parameter and 500ed the page.
  it('treats an id past int4 as not selected and never sends it to the database', async () => {
    const data = await load('?selected=99999999999');
    expect(data.selectedMissing).toBeNull();
    expect(data.pinned).toBeNull();
    expect(captured.params.flat()).not.toContain(99999999999);
  });
});
