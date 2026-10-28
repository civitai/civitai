import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getTrial = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/player-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/player-status')>()),
  getPlayerStatus,
}));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: {} }));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed }));
vi.mock('$lib/server/trials/runtime', () => ({ trialDeps: {} }));
vi.mock('$lib/server/trials/trials.service', () => ({ answerTrial: vi.fn(), getTrial }));

const { load } = await import('./+page.server');

const run = () => load({ locals: { user: { id: 7 } } } as never) as Promise<Record<string, any>>;

beforeEach(() => {
  getPlayerStatus.mockReset();
  getTrial.mockReset();
  getFeed.mockReset();
  getFeed.mockResolvedValue(null);
});

describe('play load', () => {
  it('sends a player with no row to Trials as a level 1 Acolyte', async () => {
    getPlayerStatus.mockResolvedValue(null);
    getTrial.mockResolvedValue({ kind: 'unavailable' });

    const page = await run();

    expect(page.mode).toBe('trials');
    expect(page.status).toMatchObject({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
  });

  it('sends an Acolyte to Trials', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 2 });
    getTrial.mockResolvedValue({ kind: 'unavailable' });
    expect((await run()).mode).toBe('trials');
  });

  it('keeps Knights on the queue', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(getTrial).not.toHaveBeenCalled();
  });
});
