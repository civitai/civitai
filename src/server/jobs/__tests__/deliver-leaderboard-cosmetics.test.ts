import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LeaderboardService from '~/server/services/leaderboard.service';

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
}));
vi.mock('~/server/services/leaderboard.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LeaderboardService>()),
  isLeaderboardPopulated: async () => true,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { deliverLeaderboardCosmetics } from '~/server/jobs/deliver-leaderboard-cosmetics';

type RawCall = [TemplateStringsArray, ...unknown[]];

/** The Legacy board's deliver and revoke statements, with the values bound into each. */
async function legacyNameplateStatements() {
  dbMock.dbWrite.$executeRaw.mockClear();
  await deliverLeaderboardCosmetics.run();
  return (dbMock.dbWrite.$executeRaw.mock.calls as RawCall[])
    .map(([strings, ...values]) => ({ sql: strings.join('?'), values }))
    .filter(({ sql }) => sql.includes('LegendsBoardResult'));
}

describe('deliver-leaderboard-cosmetics: Legacy nameplate lookup', () => {
  beforeEach(() => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
  });

  it('finds the plate under its old and new names, in both deliver and revoke', async () => {
    const statements = await legacyNameplateStatements();
    expect(statements.map(({ sql }) => sql.match(/-- (\w+) leaderboard legend/)?.[1])).toEqual([
      'Deliver',
      'Revoke',
    ]);
    for (const { sql, values } of statements) {
      expect(sql).toContain('AND name = ANY(?)');
      expect(sql).not.toContain("'Legendary Nameplate'");
      expect(values).toContainEqual(['Legacy Nameplate', 'Legendary Nameplate']);
    }
  });

  // The revoke deletes the plate from everyone off the Legacy board. If it ever matched the Creator
  // Journey Legend tier's plate, it would strip that plate from every Legend each night.
  it('never matches the Legend tier plate', async () => {
    for (const { sql, values } of await legacyNameplateStatements()) {
      expect(sql).not.toContain('Legend Nameplate');
      for (const value of values) {
        if (Array.isArray(value)) expect(value).not.toContain('Legend Nameplate');
      }
    }
  });
});
