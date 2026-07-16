import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPaginatedCosmetics,
  grantCosmeticsToUsers,
  insertUserCosmeticGrant,
} from './cosmetics.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getPaginatedCosmetics', () => {
  it('applies the name + types filters, orders newest-first, and paginates', async () => {
    await getPaginatedCosmetics(harness.db, {
      page: 2,
      limit: 20,
      name: 'gold',
      types: ['Badge', 'NamePlate'],
    });
    // Runs a count then the items query; the items query is last.
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "Cosmetic"');
    expect(sql).toContain('"name" ilike $1');
    expect(sql).toContain('"type" in ($2, $3)');
    expect(sql).toContain('order by "createdAt" desc');
    expect(sql).toContain('limit $4');
    expect(sql).toContain('offset $5');
    // name substring, the two types, limit, offset=(page-1)*limit
    expect(parameters).toEqual(['%gold%', 'Badge', 'NamePlate', 20, 20]);
  });

  it('omits the name and type predicates when those filters are absent', async () => {
    await getPaginatedCosmetics(harness.db, {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).not.toContain('ilike');
    expect(sql).not.toContain('"type" in');
    expect(sql).not.toContain('in ()');
    expect(sql).toContain('order by "createdAt" desc');
    // default limit 60, offset 0
    expect(parameters).toEqual([60, 0]);
  });

  it('omits the type predicate for an empty types array (no IN ())', async () => {
    await getPaginatedCosmetics(harness.db, { name: 'foo', types: [] });
    const { sql } = harness.lastQuery();

    expect(sql).toContain('"name" ilike $1');
    expect(sql).not.toContain('"type" in');
    expect(sql).not.toContain('in ()');
  });
});

describe('insertUserCosmeticGrant', () => {
  it('builds the idempotent INSERT ... SELECT ... ON CONFLICT DO NOTHING', async () => {
    await insertUserCosmeticGrant(harness.db, { userId: 7, cosmeticIds: [1, 2, 3] });
    const { sql, parameters } = harness.lastQuery();

    expect(norm(sql)).toContain('INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")');
    expect(norm(sql)).toContain("SELECT $1, c.id, 'claimed'");
    expect(norm(sql)).toContain('WHERE c.id IN ($2, $3, $4)');
    expect(norm(sql)).toContain('ON CONFLICT DO NOTHING');
    expect(sql).not.toContain('IN ()');
    // userId is $1; the cosmetic ids follow — 'claimed' is a literal, not a parameter.
    expect(parameters).toEqual([7, 1, 2, 3]);
  });
});

describe('grantCosmeticsToUsers', () => {
  it('short-circuits an empty cosmeticIds list WITHOUT running a query', async () => {
    const result = await grantCosmeticsToUsers(harness.db, { cosmeticIds: [], userIds: [1, 2] });

    expect(result).toEqual({ totalPairs: 0, alreadyOwned: 0, newlyGranted: 0 });
    expect(harness.queries).toHaveLength(0);
  });

  it('short-circuits an empty userIds list WITHOUT running a query', async () => {
    const result = await grantCosmeticsToUsers(harness.db, { cosmeticIds: [1, 2], userIds: [] });

    expect(result).toEqual({ totalPairs: 0, alreadyOwned: 0, newlyGranted: 0 });
    expect(harness.queries).toHaveLength(0);
  });

  it('validates cosmetics first — compiles the existence check and throws on missing ids', async () => {
    // The offline harness returns no rows, so validation reports every id missing and throws before the
    // insert. That still lets us assert the existence-check SQL that ran first.
    await expect(
      grantCosmeticsToUsers(harness.db, { cosmeticIds: [10, 11], userIds: [20] })
    ).rejects.toThrow(/cosmetics don't exist: 10, 11/);

    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('from "Cosmetic"');
    expect(sql).toContain('"id" in ($1, $2)');
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([10, 11]);
  });
});
