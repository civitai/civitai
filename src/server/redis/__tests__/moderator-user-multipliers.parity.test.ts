import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { foldUserMultipliers, type UserMultiplierRow } from '~/server/redis/user-multipliers';
import { foldRewardsMultipliers } from '../../../../apps/moderator/src/lib/server/user-multipliers';

// The moderator app pays accepted-report rewards and reads a reporter's tier from Postgres when the
// shared cache cannot answer. The two apps share no runtime code, so its copy of the lookup and the
// fold is pinned here to the main app's userMultipliersCache: a member tier that drifts between them
// is paid differently depending on which app happened to price the reward.

/** The SQL template body, with each interpolation reduced to `?` and whitespace squashed. */
function templateBody(file: string, opener: string) {
  const source = readFileSync(join(process.cwd(), file), 'utf8');
  const start = source.indexOf(opener);
  expect(start, `${opener} not found in ${file}`).toBeGreaterThan(-1);
  expect(source.indexOf(opener, start + 1), `${opener} is not unique in ${file}`).toBe(-1);
  const bodyStart = start + opener.length;
  const body = source.slice(bodyStart, source.indexOf('`', bodyStart));
  return body
    .replace(/\$\{[^}]*\}/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the moderator copy of the user multipliers lookup', () => {
  it('runs the main app SQL', () => {
    const main = templateBody('src/server/redis/caches.ts', 'db.$queryRaw<UserMultiplierRow[]>`');
    const moderator = templateBody(
      'apps/moderator/src/lib/server/rewards.ts',
      'sql<UserMultiplierRow>`'
    );
    // Control: the extraction found the lookup, not an empty or unrelated template.
    expect(main).toContain(`cs.status IN ('active', 'trialing')`);
    expect(moderator).toBe(main);
  });

  const row = (
    userId: number,
    rewardsMultiplier: number | null,
    rewardsIneligible = false
  ): UserMultiplierRow => ({
    userId,
    rewardsIneligible,
    rewardsMultiplier,
    purchasesMultiplier: null,
  });

  // One user per case, each chosen where a plausible rewrite of the fold gives a different answer.
  const fixtures: [string, UserMultiplierRow[]][] = [
    ['no subscription', [row(1, null)]],
    ['gold', [row(2, 4)]],
    ['the best of several subscriptions', [row(3, 1.5), row(3, 4), row(3, null)]],
    ['a placeholder grant beside a paid one', [row(4, null), row(4, 2.5)]],
    ['a product priced below 1', [row(5, 0.5)]],
    ['a negative product', [row(6, -1)]],
    ['NaN', [row(7, NaN)]],
    ['Infinity', [row(8, Infinity)]],
    ['-Infinity', [row(9, -Infinity)]],
    ['a numeric string from the driver', [row(10, '4.00' as unknown as number)]],
    ['an ineligible gold member', [row(11, 4, true), row(11, 2, true)]],
  ];

  it.each(fixtures)('folds %s to the main app value', (_name, rows) => {
    const userId = rows[0].userId;
    expect(foldRewardsMultipliers(rows).get(userId)).toBe(
      foldUserMultipliers(rows)[userId].rewardsMultiplier
    );
  });

  it('folds a batch of users to the main app values', () => {
    const rows = fixtures.flatMap(([, r]) => r);
    const main = foldUserMultipliers(rows);
    const moderator = foldRewardsMultipliers(rows);
    expect(Object.fromEntries(moderator)).toEqual(
      Object.fromEntries(Object.values(main).map((m) => [m.userId, m.rewardsMultiplier]))
    );
  });
});
