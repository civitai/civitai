import { describe, expect, it, vi } from 'vitest';

/**
 * An image can hold several appeals over time (an approved one, then a pending one after a re-block).
 * The moderator resolve paths close "the" appeal by `status = 'Pending'` alone, so that filter is what
 * keeps a decision from landing on an earlier appeal and refunding its fee a second time.
 */

const { sql, params, rows } = vi.hoisted(() => ({
  sql: [] as string[],
  params: [] as unknown[][],
  rows: [] as unknown[],
}));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(sql, rows, params);
  return { dbRead: db, dbWrite: db };
});
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
// acceptImage busts caches before it reaches the appeal; any redis call resolves to nothing.
vi.mock('$lib/server/redis', () => {
  const inert: object = new Proxy(() => Promise.resolve(null), {
    get: (_, key) => (key === 'then' ? undefined : inert),
  });
  return { getRedis: () => inert, getSysRedis: () => inert };
});

const { acceptImage, resolveImageAppeal } = await import('../image-moderation.service');

async function appealStatementsOf(run: () => Promise<unknown>) {
  sql.length = 0;
  params.length = 0;
  await run().catch(() => undefined);
  return sql
    .map((text, i) => ({ text, params: params[i] }))
    .filter(({ text }) => text.includes('"Appeal"'));
}

function expectPendingOnly(statements: { text: string; params: unknown[] }[]) {
  expect(statements.map(({ text }) => text.split(' ')[0])).toEqual(['update']);
  // Read from the WHERE clause: the update's SET also binds a status.
  for (const { text, params: bound } of statements) {
    const placeholder = / where .*"status" = \$(\d+)/.exec(text)?.[1];
    expect(placeholder, text).toBeDefined();
    expect(bound[Number(placeholder) - 1]).toBe('Pending');
  }
}

describe('the moderator appeal resolve paths', () => {
  it('resolveImageAppeal closes only the pending appeal', async () => {
    rows.length = 0;
    expectPendingOnly(
      await appealStatementsOf(() =>
        resolveImageAppeal({
          imageId: 41,
          status: 'Rejected',
          resolvedReason: 'violation-confirmed',
          userId: 2,
        })
      )
    );
  });

  it('acceptImage on an appealed image closes only the pending appeal', async () => {
    rows.length = 0;
    rows.push({
      id: 41,
      userId: 1,
      needsReview: 'appeal',
      pHash: null,
      postId: null,
      buzzTransactionId: null,
    });
    expectPendingOnly(await appealStatementsOf(() => acceptImage({ imageId: 41, userId: 2 })));
  });
});
