import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));

import { getUnpopulatedLeaderboards, isLeaderboardPopulated } from '../leaderboard.service';

const TODAY = '2026-10-09';
const queryRaw = dbMock.dbWrite.$queryRaw;

const board = (id: string, hasRows: boolean, marker: string | null) => ({
  id,
  hasRows,
  marker,
  today: TODAY,
});

describe('isLeaderboardPopulated', () => {
  beforeEach(() => queryRaw.mockReset());

  it('counts a board with zero rows as populated when its marker is dated today', async () => {
    queryRaw.mockResolvedValue([board('with-rows', true, null), board('empty', false, TODAY)]);
    expect(await isLeaderboardPopulated()).toBe(true);
    expect(await getUnpopulatedLeaderboards()).toEqual([]);
  });

  it('fails when a board has zero rows and no marker', async () => {
    queryRaw.mockResolvedValue([board('with-rows', true, null), board('empty', false, null)]);
    expect(await isLeaderboardPopulated()).toBe(false);
    expect(await getUnpopulatedLeaderboards()).toEqual(['empty']);
  });

  it('fails when the marker is from an earlier night', async () => {
    queryRaw.mockResolvedValue([board('empty', false, '2026-10-08')]);
    expect(await isLeaderboardPopulated()).toBe(false);
  });
});
