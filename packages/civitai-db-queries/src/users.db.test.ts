import { beforeEach, describe, expect, it } from 'vitest';
import { searchUsers } from './users.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('searchUsers', () => {
  it('builds a prefix search: like query%, excludes deleted + system user, ordered by username length', async () => {
    await searchUsers(harness.db, { query: 'alice', limit: 5 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "username", "image" from "User" ' +
        'where "username" like $1 and "deletedAt" is null and "id" != $2 ' +
        'order by length(username) asc limit $3'
    );
    // like prefix, system-user guard, limit
    expect(parameters).toEqual(['alice%', -1, 5]);
  });

  it('trims the query and defaults the limit to 10', async () => {
    await searchUsers(harness.db, { query: '  bob  ' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('order by length(username) asc');
    expect(parameters).toEqual(['bob%', -1, 10]);
  });

  it('short-circuits an empty/whitespace query WITHOUT running a query', async () => {
    const result = await searchUsers(harness.db, { query: '   ' });

    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });
});
