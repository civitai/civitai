import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatusOrNew = vi.hoisted(() => vi.fn());
const getTrial = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const getRecap = vi.hoisted(() => vi.fn());
const dismissRecap = vi.hoisted(() => vi.fn());
const pickHiddenCheck = vi.hoisted(() => vi.fn());
const hasUnseenReset = vi.hoisted(() => vi.fn());
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatusOrNew }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({ getDailyStatus, getRecap, dismissRecap }));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/smites/smites.service', () => ({
  hasUnseenReset,
  dismissResetNotice: vi.fn(),
}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  pickHiddenCheck,
  answerHiddenCheck: vi.fn(),
}));
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
  pickHiddenCheck.mockReset();
  pickHiddenCheck.mockResolvedValue(null);
  hasUnseenReset.mockReset();
  hasUnseenReset.mockResolvedValue(false);
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

describe('play load feed', () => {
  const feed = {
    question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
    items: [{ id: 3, imageKey: 'key-3', width: 1, height: 1 }],
  };
  const hidden = {
    referenceId: 5,
    question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
    imageKey: 'key-9',
    width: 1,
    height: 1,
  };
  beforeEach(() => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight', level: 2, smites: 0, maxSmites: 3 });
    getFeed.mockResolvedValue(feed);
  });

  it('serves a queue item and a hidden check in the same shape, with nothing that tells them apart', async () => {
    const queued = await run();
    pickHiddenCheck.mockResolvedValue(hidden);
    const check = await run();

    expect(Object.keys(check.item).sort()).toEqual(Object.keys(queued.item).sort());
    expect(Object.keys(check.question).sort()).toEqual(Object.keys(queued.question).sort());
    expect(check.item.src).toBe('key-9');
    expect(typeof check.item.id).toBe('string');
    expect(check.item.id).toHaveLength(queued.item.id.length);
    expect(JSON.stringify(check)).not.toMatch(/hidden|referenceId|pool|answer/i);
  });

  it('serves no hidden check when the queue is empty', async () => {
    getFeed.mockResolvedValue(null);
    pickHiddenCheck.mockResolvedValue(hidden);
    expect((await run()).item).toBeNull();
  });

  it('serves nothing while a career reset is due', async () => {
    getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight', level: 2, smites: 3, maxSmites: 3 });
    const page = await run();
    expect(page.item).toBeNull();
    expect(page.resetPending).toBe(true);
  });

  it('carries the reset notice', async () => {
    hasUnseenReset.mockResolvedValue(true);
    expect((await run()).resetNotice).toBe(true);
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
