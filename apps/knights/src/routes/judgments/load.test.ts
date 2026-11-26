import { beforeEach, describe, expect, it, vi } from 'vitest';

const listJudgments = vi.hoisted(() => vi.fn());
const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({
  imageUrl: (key: string, width?: number) => `cdn/${key}@${width}`,
  THUMBNAIL_WIDTH: 192,
  imagePageUrl: (id: number) => `site/images/${id}`,
}));
vi.mock('$lib/server/progression/judgments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/progression/judgments')>()),
  listJudgments,
}));
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
  it('sends a user who has not joined to the home page', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 303, location: '/home' });
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
      expect(listJudgments).toHaveBeenLastCalledWith({}, 7, { page: 1, filter: 'all' });
    }
    await run('?page=3');
    expect(listJudgments).toHaveBeenLastCalledWith({}, 7, { page: 3, filter: 'all' });
  });

  it('reads the status filter from the query and ignores one it does not know', async () => {
    await run('?status=wrong&page=2');
    expect(listJudgments).toHaveBeenLastCalledWith({}, 7, { page: 2, filter: 'wrong' });
    expect((await run('?status=wrong')).filter).toBe('wrong');
    expect((await run('?status=nonsense')).filter).toBe('all');
  });

  it('turns image keys into urls and leaves a withdrawn image without one', async () => {
    listJudgments.mockResolvedValue({
      hasMore: true,
      judgments: [
        { itemId: 1, imageId: 5, imageKey: 'a', at: new Date('2026-12-15T10:00:00Z') },
        { itemId: 2, imageId: 6, imageKey: null, at: new Date('2026-12-15T09:00:00Z') },
      ],
    });

    const page = await run();

    expect(page.hasMore).toBe(true);
    expect(page.judgments.map((j: { src: string | null }) => j.src)).toEqual(['cdn/a@192', null]);
    expect(page.judgments.map((j: { imageHref: string | null }) => j.imageHref)).toEqual([
      'site/images/5',
      null,
    ]);
    expect(page.status).toMatchObject({ rank: 'Acolyte', fervor: 0 });
  });
});
