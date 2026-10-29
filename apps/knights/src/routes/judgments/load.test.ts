import { beforeEach, describe, expect, it, vi } from 'vitest';

const listJudgments = vi.hoisted(() => vi.fn());
const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => `cdn/${key}` }));
vi.mock('$lib/server/progression/judgments', () => ({ listJudgments }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));

const { load } = await import('./+page.server');

const run = (query = '') =>
  load({
    locals: { user: { id: 7 } },
    url: new URL(`http://knights.test/judgments${query}`),
  } as never) as Promise<Record<string, any>>;

beforeEach(() => {
  listJudgments.mockReset();
  getPlayerStatus.mockReset();
  getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', fervor: 0 });
  listJudgments.mockResolvedValue({ judgments: [], hasMore: false });
});

describe('judgments load', () => {
  it('sends a user who has not joined to the front page', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 303, location: '/' });
  });

  it('reads only the signed-in player and falls back to page 1 for a bad page', async () => {
    for (const bad of [
      '?page=0',
      '?page=abc',
      '?page=1.5',
      '?page=9007199254740993',
      '?page=1001',
      '',
    ]) {
      await run(bad);
      expect(listJudgments).toHaveBeenLastCalledWith({}, 7, { page: 1 });
    }
    await run('?page=3');
    expect(listJudgments).toHaveBeenLastCalledWith({}, 7, { page: 3 });
  });

  it('turns image keys into urls and leaves a withdrawn image without one', async () => {
    listJudgments.mockResolvedValue({
      hasMore: true,
      judgments: [
        { itemId: 1, imageKey: 'a', at: new Date('2026-12-15T10:00:00Z') },
        { itemId: 2, imageKey: null, at: new Date('2026-12-15T09:00:00Z') },
      ],
    });

    const page = await run();

    expect(page.hasMore).toBe(true);
    expect(page.judgments.map((j: { src: string | null }) => j.src)).toEqual(['cdn/a', null]);
    expect(page.status).toMatchObject({ rank: 'Acolyte', fervor: 0 });
  });
});
