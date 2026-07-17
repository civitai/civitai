import { beforeEach, describe, expect, it } from 'vitest';
import {
  getBlocklist,
  getBlocklistData,
  removeBlocklistItems,
  upsertBlocklist,
} from './blocklist.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getBlocklist', () => {
  it('selects the single row for a type', async () => {
    await getBlocklist(harness.db, { type: 'email' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "id", "type", "data" from "Blocklist" where "type" = $1 limit $2');
    expect(parameters).toEqual(['email', 1]);
  });
});

describe('getBlocklistData', () => {
  it('selects just the data column for a type (the enforcement read core)', async () => {
    await getBlocklistData(harness.db, { type: 'linkDomain' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "data" from "Blocklist" where "type" = $1 limit $2');
    expect(parameters).toEqual(['linkDomain', 1]);
  });

  it('runs exactly one query (no redis cache read ported)', async () => {
    await getBlocklistData(harness.db, { type: 'messagePattern' });
    expect(harness.queries).toHaveLength(1);
  });
});

describe('upsertBlocklist', () => {
  it('inserts a new row (no id), lowercasing items, dropping empties, stamping updatedAt', async () => {
    // executeTakeFirstOrThrow rejects on the empty DummyDriver result, but the query is still logged first.
    await upsertBlocklist(harness.db, { type: 'email', blocklist: ['FOO', '', 'Bar'] }).catch(
      () => {}
    );
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'insert into "Blocklist" ("type", "data", "updatedAt") values ($1, $2, $3) ' +
        'returning "id", "type", "data"'
    );
    expect(parameters[0]).toBe('email');
    expect(parameters[1]).toEqual(['foo', 'bar']); // lowercased, empty dropped
    expect(parameters[2]).toBeInstanceOf(Date); // updatedAt stamped, not left to a trigger
  });

  it('reads existing data then updates (merge) when given an id, stamping updatedAt', async () => {
    await upsertBlocklist(harness.db, { id: 5, type: 'email', blocklist: ['NEW'] }).catch(() => {});

    // Two statements: the existing-data read, then the merge update.
    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[0].sql).toBe('select "data" from "Blocklist" where "id" = $1');
    expect(harness.queries[0].parameters).toEqual([5]);

    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "Blocklist" set "data" = $1, "updatedAt" = $2 where "id" = $3 ' +
        'returning "id", "type", "data"'
    );
    expect(parameters[0]).toEqual(['new']); // existing undefined on the dummy driver → just the new item
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(5);
  });
});

describe('removeBlocklistItems', () => {
  it('reads the row first and short-circuits (returns undefined) when it is absent', async () => {
    const result = await removeBlocklistItems(harness.db, { id: 5, items: ['Foo'] });

    expect(result).toBeUndefined();
    // Only the read ran; with no row there is no UPDATE (its shape is covered by upsertBlocklist's update path).
    expect(harness.queries).toHaveLength(1);
    expect(harness.lastQuery().sql).toBe('select "data" from "Blocklist" where "id" = $1');
    expect(harness.lastQuery().parameters).toEqual([5]);
  });
});
