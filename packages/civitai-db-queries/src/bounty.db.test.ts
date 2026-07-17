import { beforeEach, describe, expect, it } from 'vitest';
import { deleteBountyEntryForUser, deleteBountyForUser } from './bounty.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('bounty per-table deletes', () => {
  it('deleteBountyForUser: delete from table where userId', async () => {
    await deleteBountyForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Bounty" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });

  it('deleteBountyEntryForUser filters to entries with no benefactors', async () => {
    await deleteBountyEntryForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('delete from "BountyEntry" where "userId" = $1');
    expect(sql).toContain(
      'not exists (select 1 as "one" from "BountyBenefactor" where "BountyBenefactor"."awardedToId" = "BountyEntry"."id")'
    );
    expect(parameters).toEqual([7]);
  });
});
