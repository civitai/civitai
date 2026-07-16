import { beforeEach, describe, expect, it } from 'vitest';
import { getGlobalRewardsBonus } from './rewards.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getGlobalRewardsBonus', () => {
  it('reads enabled RewardsBonusEvent rows (multiplier + window), filtering by enabled', async () => {
    await getGlobalRewardsBonus(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "multiplier", "startsAt", "endsAt" from "RewardsBonusEvent" where "enabled" = $1'
    );
    expect(parameters).toEqual([true]);
  });

  it('runs exactly one query (no ClickHouse/redis side-effects ported)', async () => {
    await getGlobalRewardsBonus(harness.db);
    expect(harness.queries).toHaveLength(1);
  });
});
