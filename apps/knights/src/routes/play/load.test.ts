import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatusOrNew = vi.hoisted(() => vi.fn());
const getTrial = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const getRecap = vi.hoisted(() => vi.fn());
const dismissRecap = vi.hoisted(() => vi.fn());
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatusOrNew }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({ getDailyStatus, getRecap, dismissRecap }));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed }));
vi.mock('$lib/server/trials/runtime', () => ({ trialDeps: {} }));
vi.mock('$lib/server/trials/trials.service', () => ({ answerTrial: vi.fn(), getTrial }));

const { load, actions } = await import('./+page.server');

const run = () => load({ locals: { user: { id: 7 } } } as never) as Promise<Record<string, any>>;

beforeEach(() => {
  getPlayerStatusOrNew.mockReset();
  getTrial.mockReset();
  getFeed.mockReset();
  getFeed.mockResolvedValue(null);
  getDailyStatus.mockReset();
  getDailyStatus.mockResolvedValue({ votes: 3 });
  getRecap.mockReset();
  getRecap.mockResolvedValue(null);
  dismissRecap.mockReset();
});

describe('play load', () => {
  it('sends a level 1 Acolyte to Trials', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
    getTrial.mockResolvedValue({ kind: 'unavailable' });

    const page = await run();

    expect(page.mode).toBe('trials');
    expect(page.status).toMatchObject({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
  });

  it('sends an Acolyte to Trials', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Acolyte', level: 2 });
    getTrial.mockResolvedValue({ kind: 'unavailable' });
    expect((await run()).mode).toBe('trials');
  });

  it('keeps Knights on the queue', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight', level: 2 });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(getTrial).not.toHaveBeenCalled();
  });

  it('gives a Knight the day, evaluated at the injected clock, and the recap', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight', level: 2 });
    getRecap.mockResolvedValue({ cast: 30 });

    const page = await run();

    expect(page.daily).toEqual({ votes: 3 });
    expect(page.recap).toEqual({ cast: 30 });
    expect(getDailyStatus).toHaveBeenCalledWith(expect.anything(), {
      playerId: 7,
      rank: 'Knight',
      now: NOW,
    });
    expect(getRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('keeps the daily loop off the Trials page', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Acolyte', level: 1 });
    getTrial.mockResolvedValue({ kind: 'unavailable' });
    await run();
    expect(getDailyStatus).not.toHaveBeenCalled();
  });
});

describe('dismissRecap action', () => {
  const run = () => actions.dismissRecap({ locals: { user: { id: 7 } } } as never);

  it('stores the dismissal for the caller at the injected clock', async () => {
    await run();
    expect(dismissRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('tells the player when it could not be stored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dismissRecap.mockRejectedValue(new Error('down'));

    expect(await run()).toMatchObject({
      status: 500,
      data: { message: 'Could not dismiss the recap. Try again.', recapFailed: true },
    });
    expect(log).toHaveBeenCalled();
  });
});
