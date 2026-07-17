import { beforeEach, describe, expect, it } from 'vitest';
import { deleteAnswerForUser, deleteQuestionForUser } from './qa.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('qa per-table deletes', () => {
  const simpleDeletes: Array<[string, (userId: number) => unknown, string]> = [
    ['Answer', (u) => deleteAnswerForUser(h.db, u), 'Answer'],
    ['Question', (u) => deleteQuestionForUser(h.db, u), 'Question'],
  ];

  it.each(simpleDeletes)('%s: delete from table where userId', async (_name, fn, table) => {
    await fn(7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(`delete from "${table}" where "userId" = $1`);
    expect(parameters).toEqual([7]);
  });
});
