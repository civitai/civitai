import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('./player-status', () => ({ getPlayerStatus }));
const seenStore = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('./seen-runtime', () => ({ seenStore }));

const { consented, requireConsent, requireMember } = await import('./membership');

beforeEach(() => {
  getPlayerStatus.mockReset();
  seenStore.get.mockReset();
});

describe('requireMember', () => {
  it('returns the status of a player', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight' });
    expect(await requireMember({} as never, 7)).toEqual({ rank: 'Knight' });
    expect(getPlayerStatus).toHaveBeenCalledWith({}, 7);
  });

  it('sends a user with no player row to the home page', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(requireMember({} as never, 7)).rejects.toMatchObject({
      status: 303,
      location: '/home',
    });
  });
});

describe('the mature content warning', () => {
  const record = { rank: 'Knight', level: 30, guide: true, whatsNew: true };

  it('lets a player who accepted it through', async () => {
    seenStore.get.mockResolvedValue({ ...record, consent: true });
    expect(await consented(7)).toBe(true);
    await expect(requireConsent(7)).resolves.toBeUndefined();
  });

  it('sends a v1 player whose record predates it to the home page, which asks for it', async () => {
    seenStore.get.mockResolvedValue(record);
    expect(await consented(7)).toBe(false);
    await expect(requireConsent(7)).rejects.toMatchObject({ status: 303, location: '/home' });
  });

  it('treats a player with no record as not having accepted it', async () => {
    seenStore.get.mockResolvedValue(null);
    expect(await consented(7)).toBe(false);
  });

  it('lets the player through when the store cannot be read, rather than locking everyone out', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    seenStore.get.mockRejectedValue(new Error('down'));
    expect(await consented(7)).toBe(true);
    expect(log).toHaveBeenCalled();
  });
});
