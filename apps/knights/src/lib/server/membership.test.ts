import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('./player-status', () => ({ getPlayerStatus }));

const { requireMember } = await import('./membership');

beforeEach(() => getPlayerStatus.mockReset());

describe('requireMember', () => {
  it('returns the status of a player', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight' });
    expect(await requireMember({} as never, 7)).toEqual({ rank: 'Knight' });
    expect(getPlayerStatus).toHaveBeenCalledWith({}, 7);
  });

  it('sends a user with no player row to the front page', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(requireMember({} as never, 7)).rejects.toMatchObject({
      status: 303,
      location: '/',
    });
  });
});
