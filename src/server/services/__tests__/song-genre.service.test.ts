import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';

const cached = vi.hoisted(() => ({ tags: new Map<string, { id: number; name: string }>() }));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  tagCacheByName: {
    fetch: vi.fn(async (names: string[]) => ({
      found: new Map(
        names.flatMap((name) => (cached.tags.has(name) ? [[name, cached.tags.get(name)!]] : []))
      ),
      missing: names.filter((name) => !cached.tags.has(name)),
    })),
    setMany: vi.fn(async () => undefined),
    bust: vi.fn(),
  },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { tagCacheByName } from '~/server/redis/caches';
import { getSongGenreTagIds } from '~/server/services/song-genre.service';

const findMany = dbMock.dbRead.tag.findMany as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  cached.tags = new Map();
  vi.mocked(tagCacheByName.fetch).mockClear();
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe('getSongGenreTagIds', () => {
  it('maps each genre to the id of its mirrored tag, reading cache misses from the db', async () => {
    cached.tags.set('pop', { id: 11, name: 'pop' });
    findMany.mockResolvedValue([
      { id: 29, name: 'synthwave', type: 'UserGenerated', nsfwLevel: 1 },
      { id: 31, name: 'r&b', type: 'UserGenerated', nsfwLevel: 1 },
    ]);

    const ids = await getSongGenreTagIds({ features: { music: true } });

    expect(ids).toEqual({ Pop: 11, Synthwave: 29, 'R&B': 31 });
    // Only the names the cache did not hold go to the db.
    const where = findMany.mock.calls[0][0].where.name.in as string[];
    expect(where).not.toContain('pop');
    expect(where).toContain('synthwave');
  });

  it('leaves out a genre whose tag does not exist yet', async () => {
    const ids = await getSongGenreTagIds({ features: { music: true } });
    expect(ids).toEqual({});
  });

  it('returns nothing and reads nothing with the music flag off', async () => {
    cached.tags.set('pop', { id: 11, name: 'pop' });

    const ids = await getSongGenreTagIds({ features: { music: false } });

    expect(ids).toEqual({});
    expect(tagCacheByName.fetch).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
