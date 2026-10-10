import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HatSync from '~/server/events/points/sync';

const hatSync = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('~/server/events/points/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof HatSync>()),
  syncOwnerEventHats: hatSync.owner,
}));

const roster = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock('~/server/events/points/roster-sync', () => ({ syncEventRosterMember: roster.member }));

const { setLeaderboardEligibility } = await import('~/server/services/user.service');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRawUnsafe.mockResolvedValue(1);
});

// An owner excluded from leaderboards stops earning event points at once, and earns again when
// let back in.
describe('setLeaderboardEligibility -> live event hats', () => {
  it.each([true, false])(
    'brings the owner’s hats up to date after the write (excluded: %s)',
    async (setTo) => {
      await setLeaderboardEligibility({ id: 9, setTo });
      expect(hatSync.owner.mock.calls).toEqual([[9]]);
      expect(hatSync.owner.mock.invocationCallOrder[0]).toBeGreaterThan(
        dbMock.dbWrite.$executeRawUnsafe.mock.invocationCallOrder[0]
      );
    }
  );

  // Excluded, they leave their team's roster; let back in, they are listed again if opted in.
  it.each([true, false])(
    're-derives their roster entry after the write (excluded: %s)',
    async (setTo) => {
      await setLeaderboardEligibility({ id: 9, setTo });
      expect(roster.member.mock.calls).toEqual([[9]]);
      expect(roster.member.mock.invocationCallOrder[0]).toBeGreaterThan(
        dbMock.dbWrite.$executeRawUnsafe.mock.invocationCallOrder[0]
      );
    }
  );
});
