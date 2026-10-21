import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

/** Every raw statement the run issued, in order — the revokes return rows, so they are queries. */
function rawStatements() {
  const { $executeRaw, $queryRaw } = dbMock.dbWrite;
  return [$executeRaw, $queryRaw]
    .flatMap((fn) =>
      (fn.mock.calls as RawCall[]).map(([strings, ...values], i) => ({
        order: fn.mock.invocationCallOrder[i],
        sql: strings.join('?'),
        values,
      }))
    )
    .sort((a, b) => a.order - b.order);
}

/** The Legacy board's deliver and revoke statements, with the values bound into each. */
async function legacyNameplateStatements() {
  dbMock.dbWrite.$executeRaw.mockClear();
  dbMock.dbWrite.$queryRaw.mockClear();
  await deliverLeaderboardCosmetics.run();
  return rawStatements().filter(({ sql }) => sql.includes('LegendsBoardResult'));
}

describe('deliver-leaderboard-cosmetics: Legacy nameplate lookup', () => {
  beforeEach(() => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
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

describe('deliver-leaderboard-cosmetics: worn cosmetics cache', () => {
  const WEARER = 31;
  const HOLDER = 32;
  const PLACED = 33;
  const NEXT_BEST = 34;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('-- Equip next best')) return [{ userId: NEXT_BEST }];
      if (sql.includes('-- Revoke leaderboard cosmetics'))
        return [
          { userId: WEARER, equippedAt: new Date(), equippedToId: null },
          { userId: HOLDER, equippedAt: null, equippedToId: null },
          { userId: PLACED, equippedAt: new Date(), equippedToId: 900 },
        ];
      return [];
    }) as never);
  });

  it('refreshes the users whose worn badge changed, and only them', async () => {
    const { userCosmeticCache } = await import('~/server/redis/caches');
    const refresh = vi.spyOn(userCosmeticCache, 'refresh').mockResolvedValue();

    await deliverLeaderboardCosmetics.run();

    const refreshed = refresh.mock.calls.flatMap(([ids]) => (Array.isArray(ids) ? ids : [ids]));
    expect(refreshed.sort()).toEqual([WEARER, NEXT_BEST].sort());
  });
});

describe('deliver-leaderboard-cosmetics: users search index', () => {
  const WEARER = 41;
  const HOLDER = 42;
  const PLACED = 43;
  const NEXT_BEST = 44;
  const LEGACY_WEARER = 45;
  const LEGACY_HOLDER = 46;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('-- Equip next best')) return [{ userId: NEXT_BEST }];
      if (sql.includes('-- Revoke leaderboard cosmetics'))
        return [
          { userId: WEARER, equippedAt: new Date(), equippedToId: null },
          { userId: HOLDER, equippedAt: null, equippedToId: null },
          { userId: PLACED, equippedAt: new Date(), equippedToId: 900 },
        ];
      if (sql.includes('-- Revoke leaderboard legend cosmetics'))
        return [
          { userId: LEGACY_WEARER, equippedAt: new Date(), equippedToId: null },
          { userId: LEGACY_HOLDER, equippedAt: null, equippedToId: null },
        ];
      return [];
    }) as never);
  });

  // Search results and user pickers render the cosmetics stored on each user's document, which
  // the sync re-pulls only for queued ids: a badge the job equips or takes off must be queued.
  it('queues the users whose worn cosmetics the job changed, and only them', async () => {
    const { usersSearchIndex } = await import('~/server/search-index/users.search-index');
    const queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
    onTestFinished(() => queue.mockRestore());

    await deliverLeaderboardCosmetics.run();

    const queued = queue.mock.calls.flatMap(([items]) => items.map((x) => x.id));
    expect(queued.sort()).toEqual([WEARER, NEXT_BEST, LEGACY_WEARER].sort());
  });
});
