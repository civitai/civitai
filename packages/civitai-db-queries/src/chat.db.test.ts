import { beforeEach, describe, expect, it } from 'vitest';
import { deleteChatMemberForUser, deleteChatMessageForUser } from './chat.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('chat per-table deletes', () => {
  const simpleDeletes: Array<[string, (userId: number) => unknown, string]> = [
    ['ChatMessage', (u) => deleteChatMessageForUser(h.db, u), 'ChatMessage'],
    ['ChatMember', (u) => deleteChatMemberForUser(h.db, u), 'ChatMember'],
  ];

  it.each(simpleDeletes)('%s: delete from table where userId', async (_name, fn, table) => {
    await fn(7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(`delete from "${table}" where "userId" = $1`);
    expect(parameters).toEqual([7]);
  });
});
