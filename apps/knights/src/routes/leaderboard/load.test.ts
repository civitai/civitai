import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({
  imageUrl: (key: string, width?: number) => `cdn/${key}@${width}`,
}));
vi.mock('$lib/server/leaderboard-runtime', () => ({ boardCache: { get } }));
vi.mock('$lib/server/leaderboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/leaderboard')>()),
  queryBoard: vi.fn(),
}));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));

const { load } = await import('./+page.server');

const run = () => load({ locals: { user: { id: 7 } } } as never) as Promise<Record<string, any>>;
const row = (userId: number, image: string | null, rankType = 'Knight') => ({
  userId,
  username: `user${userId}`,
  image,
  rankType,
  level: 3,
  fervor: 100 - userId,
});

beforeEach(() => {
  get.mockReset();
  getPlayerStatus.mockReset();
  getPlayerStatus.mockResolvedValue({ rank: 'Knight' });
  get.mockResolvedValue({ rows: [], badges: {} });
});

describe('leaderboard load', () => {
  it('sends a user who has not joined to the front page', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 303, location: '/' });
  });

  it('turns image keys into avatar urls, gives a rank its badge image, and finds the viewer', async () => {
    get.mockResolvedValue({
      rows: [
        row(1, 'key-1'),
        row(2, null, 'Paladin'),
        row(3, 'https://cdn.test/a.png', 'Templar'),
        row(7, 'key-7'),
      ],
      badges: { Knight: 'knight-key', Templar: 'templar-key' },
    });

    const data = await run();

    expect(data.entries.map((e: any) => e.avatarUrl)).toEqual([
      'cdn/key-1@48',
      null,
      'https://cdn.test/a.png',
      'cdn/key-7@48',
    ]);
    expect(data.entries.map((e: any) => e.badgeUrl)).toEqual([
      'cdn/knight-key@48',
      null,
      'cdn/templar-key@48',
      'cdn/knight-key@48',
    ]);
    expect(data.self).toMatchObject({ userId: 7, position: 4 });
    expect(data.entries[0]).not.toHaveProperty('image');
    expect(data.windowDays).toBe(7);
  });
});
