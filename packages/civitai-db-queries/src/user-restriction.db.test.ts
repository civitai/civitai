import { beforeEach, describe, expect, it } from 'vitest';
import {
  createUserRestriction,
  getPromptAllowlist,
  getUserRestrictionById,
  getUserRestrictions,
  getUserRestrictionsForBackfill,
  setUserRestrictionStatus,
  setUserRestrictionTriggers,
  updateUserRestriction,
  upsertPromptAllowlistEntry,
} from './user-restriction.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('getUserRestrictions', () => {
  it('builds the paged items query: generation type, non-deleted user, filters, newest-first', async () => {
    await getUserRestrictions(h.db, {
      page: 2,
      limit: 20,
      status: 'Pending',
      username: 'alice',
      userId: 42,
    });
    // runs a count then the items query; the items query is last.
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('from "UserRestriction"');
    expect(sql).toContain('inner join "User" on "User"."id" = "UserRestriction"."userId"');
    expect(sql).toContain('"UserRestriction"."type" = $1');
    expect(sql).toContain('"User"."deletedAt" is null');
    expect(sql).toContain('"UserRestriction"."status" = $2');
    expect(sql).toContain('"UserRestriction"."userId" = $3');
    expect(sql).toContain('"User"."username" ilike $4');
    expect(sql).toContain('json_build_object');
    expect(sql).toContain('order by "UserRestriction"."createdAt" desc');
    expect(sql).toContain('limit $5');
    expect(sql).toContain('offset $6');
    // type, status, userId, username substring, limit, offset=(page-1)*limit
    expect(parameters).toEqual(['generation', 'Pending', 42, '%alice%', 20, 20]);
  });

  it('omits the status/userId/username predicates when those filters are absent', async () => {
    await getUserRestrictions(h.db, {});
    const { sql } = h.lastQuery();

    expect(sql).not.toContain('ilike');
    expect(sql).not.toContain('"UserRestriction"."status" =');
    expect(sql).not.toContain('"UserRestriction"."userId" =');
    expect(sql).toContain('"UserRestriction"."type" = $1');
    expect(sql).toContain('"User"."deletedAt" is null');
  });
});

describe('getUserRestrictionById', () => {
  it('selects one restriction with the nested user email/username', async () => {
    await getUserRestrictionById(h.db, 7);
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('from "UserRestriction"');
    expect(sql).toContain('left join "User" on "User"."id" = "UserRestriction"."userId"');
    expect(sql).toContain('where "UserRestriction"."id" = $1');
    expect(sql).toContain('json_build_object');
    expect(parameters).toEqual([7]);
  });
});

describe('updateUserRestriction', () => {
  it('updates the given columns, auto-stamps updatedAt, and returns the row', async () => {
    await updateUserRestriction(h.db, { id: 7, status: 'Upheld' });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "UserRestriction" set "status" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters[0]).toBe('Upheld');
    expect(parameters[1]).toBeInstanceOf(Date); // updatedAt stamped (no Prisma @updatedAt hook)
    expect(parameters[2]).toBe(7);
  });
});

describe('setUserRestrictionStatus', () => {
  it('stamps status/resolvedAt/resolvedBy/resolvedMessage and updatedAt explicitly', async () => {
    await setUserRestrictionStatus(h.db, {
      id: 7,
      status: 'Upheld',
      resolvedBy: 99,
      resolvedMessage: 'confirmed',
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "UserRestriction" set "status" = $1, "resolvedAt" = $2, "resolvedBy" = $3, ' +
        '"resolvedMessage" = $4, "updatedAt" = $5 where "id" = $6'
    );
    expect(parameters[0]).toBe('Upheld');
    expect(parameters[1]).toBeInstanceOf(Date); // resolvedAt stamped, not left to a trigger
    expect(parameters[2]).toBe(99);
    expect(parameters[3]).toBe('confirmed');
    expect(parameters[4]).toBeInstanceOf(Date); // updatedAt stamped (no Prisma @updatedAt hook)
    expect(parameters[5]).toBe(7);
  });

  it('nulls resolvedMessage when omitted', async () => {
    await setUserRestrictionStatus(h.db, { id: 7, status: 'Overturned', resolvedBy: 99 });
    const { parameters } = h.lastQuery();
    expect(parameters[3]).toBeNull();
  });
});

describe('setUserRestrictionTriggers', () => {
  it('writes triggers as jsonb and stamps updatedAt', async () => {
    await setUserRestrictionTriggers(h.db, { id: 7, triggers: [{ prompt: 'x' }] });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "UserRestriction" set "triggers" = $1::jsonb, "updatedAt" = $2 where "id" = $3'
    );
    expect(parameters[0]).toBe(JSON.stringify([{ prompt: 'x' }])); // toJson, not a PG array literal
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(7);
  });
});

describe('getUserRestrictionsForBackfill', () => {
  it('lists generation restrictions newest-first with a default limit of 10', async () => {
    await getUserRestrictionsForBackfill(h.db, {});
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'select "id", "userId", "triggers", "createdAt" from "UserRestriction" ' +
        'where "type" = $1 order by "createdAt" desc limit $2'
    );
    expect(parameters).toEqual(['generation', 10]);
  });

  it('narrows to a single id when provided', async () => {
    await getUserRestrictionsForBackfill(h.db, { id: 5, limit: 25 });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('"id" = $2');
    expect(parameters).toEqual(['generation', 5, 25]);
  });
});

describe('createUserRestriction', () => {
  it('inserts a generation restriction with jsonb triggers, explicit type and updatedAt', async () => {
    await createUserRestriction(h.db, { userId: 42, triggers: [{ prompt: 'x' }] });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "UserRestriction" ("userId", "type", "triggers", "updatedAt") ' +
        'values ($1, $2, $3::jsonb, $4) returning "id", "userId", "status"'
    );
    expect(parameters[0]).toBe(42);
    expect(parameters[1]).toBe('generation');
    expect(parameters[2]).toBe(JSON.stringify([{ prompt: 'x' }]));
    expect(parameters[3]).toBeInstanceOf(Date);
  });
});

describe('upsertPromptAllowlistEntry', () => {
  it('inserts the full entry, updating only addedBy/reason on conflict', async () => {
    await upsertPromptAllowlistEntry(h.db, {
      trigger: 'foo',
      category: 'bar',
      addedBy: 99,
      reason: 'benign',
      userRestrictionId: 7,
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "PromptAllowlist" ("trigger", "category", "addedBy", "reason", "userRestrictionId") ' +
        'values ($1, $2, $3, $4, $5) on conflict ("trigger", "category") ' +
        'do update set "addedBy" = $6, "reason" = $7'
    );
    expect(parameters).toEqual(['foo', 'bar', 99, 'benign', 7, 99, 'benign']);
  });

  it('nulls the optional reason/userRestrictionId when omitted', async () => {
    await upsertPromptAllowlistEntry(h.db, { trigger: 'foo', category: 'bar', addedBy: 99 });
    const { parameters } = h.lastQuery();
    expect(parameters).toEqual(['foo', 'bar', 99, null, null, 99, null]);
  });
});

describe('getPromptAllowlist', () => {
  it('selects all trigger/category pairs', async () => {
    await getPromptAllowlist(h.db);
    const { sql } = h.lastQuery();
    expect(sql).toBe('select "trigger", "category" from "PromptAllowlist"');
  });
});
