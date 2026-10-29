import { beforeEach, describe, expect, it, vi } from 'vitest';

const isDev = vi.hoisted(() => ({ value: false }));
const simulateOtherVoters = vi.hoisted(() => vi.fn());
const listSimulatableItems = vi.hoisted(() => vi.fn());
const setPlayerLevel = vi.hoisted(() => vi.fn());
const getPlayerStatusOrNew = vi.hoisted(() => vi.fn());
const shiftMyDayBack = vi.hoisted(() => vi.fn());
vi.mock('$app/environment', () => ({
  get dev() {
    return isDev.value;
  },
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: {} }));
vi.mock('$lib/server/redis', () => ({ getSysRedis: vi.fn() }));
vi.mock('$lib/server/dev/simulate', () => ({ simulateOtherVoters, listSimulatableItems }));
vi.mock('$lib/server/dev/set-level', () => ({ setPlayerLevel }));
vi.mock('$lib/server/dev/shift-day', () => ({ shiftMyDayBack }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatusOrNew }));

const { load, actions } = await import('./+page.server');

const submit = () => {
  const body = new FormData();
  body.set('itemId', '3');
  body.set('answer', '4');
  return actions.simulate({
    request: new Request('http://knights.test/dev/simulate', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};
const submitLevel = () => {
  const body = new FormData();
  body.set('level', '30');
  return actions.setLevel({
    request: new Request('http://knights.test/dev/simulate', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};
const submitShift = () =>
  actions.shiftDay({
    request: new Request('http://knights.test/dev/simulate', {
      method: 'POST',
      body: new FormData(),
    }),
    locals: { user: { id: 7 } },
  } as never);
const loadPage = () => load({ locals: { user: { id: 7 } } } as never);

beforeEach(() => {
  simulateOtherVoters.mockReset();
  listSimulatableItems.mockReset();
  listSimulatableItems.mockResolvedValue([]);
  setPlayerLevel.mockReset();
  getPlayerStatusOrNew.mockReset();
  shiftMyDayBack.mockReset();
  getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight' });
});

describe('simulate other voters', () => {
  describe('outside dev', () => {
    beforeEach(() => {
      isDev.value = false;
    });

    it('404s the page', async () => {
      await expect(loadPage()).rejects.toMatchObject({ status: 404 });
      expect(listSimulatableItems).not.toHaveBeenCalled();
    });

    it('404s the action and casts nothing', async () => {
      await expect(submit()).rejects.toMatchObject({ status: 404 });
      expect(simulateOtherVoters).not.toHaveBeenCalled();
    });

    it('404s the level action and changes nothing', async () => {
      await expect(submitLevel()).rejects.toMatchObject({ status: 404 });
      expect(setPlayerLevel).not.toHaveBeenCalled();
    });

    it('404s the day shift and moves nothing', async () => {
      await expect(submitShift()).rejects.toMatchObject({ status: 404 });
      expect(shiftMyDayBack).not.toHaveBeenCalled();
    });
  });

  describe('in dev', () => {
    beforeEach(() => {
      isDev.value = true;
    });

    it('serves the page and runs the simulation for the caller', async () => {
      simulateOtherVoters.mockResolvedValue({ cast: 5, itemStatus: 'Resolved' });

      await expect(loadPage()).resolves.toMatchObject({ items: [] });
      await expect(submit()).resolves.toMatchObject({ success: true });
      expect(simulateOtherVoters).toHaveBeenCalledWith(
        expect.anything(),
        { callerId: 7, itemId: 3, answer: '4' },
        expect.anything()
      );
    });

    it('sets the level of the caller only', async () => {
      setPlayerLevel.mockResolvedValue({ ok: true, exp: 10, rank: 'Knight' });

      await expect(submitLevel()).resolves.toMatchObject({ success: true });
      expect(setPlayerLevel).toHaveBeenCalledWith(expect.anything(), 7, 30, expect.any(Function));
    });

    it('shifts the day of the caller only', async () => {
      shiftMyDayBack.mockResolvedValue({ ok: true, days: 2 });

      await expect(submitShift()).resolves.toMatchObject({ success: true, shifted: 2 });
      expect(shiftMyDayBack).toHaveBeenCalledWith(expect.anything(), 7);
    });

    it('tells the caller when there was nothing to shift', async () => {
      shiftMyDayBack.mockResolvedValue({ ok: false, reason: 'nothing-to-shift' });
      await expect(submitShift()).resolves.toMatchObject({ status: 400 });
    });
  });
});
