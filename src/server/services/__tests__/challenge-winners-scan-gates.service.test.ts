import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { challengeScanGates } from '~/server/services/challenge-visibility.sql';

// Pins the bug where the previous-winners list skipped feed gates, so an unscanned or real-person
// cover, or a user challenge behind the userChallenges flag, could surface there. What the scan
// gates admit is pinned against real Postgres by challenge-eligibility.parity.test.ts; this pins
// that the list applies them.

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const none = { getCached: vi.fn(async () => []) };
  return {
    ...(await importOriginal<typeof UserPreferencesService>()),
    HiddenUsers: none,
    BlockedUsers: none,
    BlockedByUsers: none,
  };
});

const { getCompletedChallengesWithWinners } = await import('~/server/services/challenge.service');

/** The WHERE of the first list query, as composed SQL. */
async function listWhere(currentUserId?: number, canAccessUserChallenges?: boolean) {
  dbMock.dbRead.$queryRaw.mockReset();
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  await getCompletedChallengesWithWinners({
    limit: 20,
    currentUserId,
    isGreen: false,
    canAccessUserChallenges,
  } as Parameters<typeof getCompletedChallengesWithWinners>[0]);
  const args = dbMock.dbRead.$queryRaw.mock.calls[0] as unknown[];
  const where = args.find(
    (a): a is Prisma.Sql =>
      typeof (a as Prisma.Sql)?.sql === 'string' && (a as Prisma.Sql).sql.startsWith('WHERE ')
  );
  if (!where) throw new Error('the winners list query has no WHERE');
  return where;
}

describe('getCompletedChallengesWithWinners scan gates (feed parity)', () => {
  it.each([
    ['an anonymous viewer', undefined],
    ['a signed-in viewer', 333],
  ])('applies every feed scan and cover gate for %s', async (_, viewerId) => {
    const where = await listWhere(viewerId);
    for (const gate of challengeScanGates(viewerId)) {
      expect(where.sql).toContain(gate.sql);
    }
  });

  // The flag gate binds the source as a parameter; the domain gate writes 'User' inline.
  const userChallengeGate = 'c.source <> ?::"ChallengeSource"';

  it('leaves user challenges out without the userChallenges flag, and by default', async () => {
    expect((await listWhere(333, false)).sql).toContain(userChallengeGate);
    expect((await listWhere(333)).sql).toContain(userChallengeGate);
  });

  it('lists user challenges for a viewer with the userChallenges flag', async () => {
    expect((await listWhere(333, true)).sql).not.toContain(userChallengeGate);
  });
});
