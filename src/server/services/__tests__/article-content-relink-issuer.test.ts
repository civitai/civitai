import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ImageService from '~/server/services/image.service';

/** Linking content with no image row creates one only for a key not issued to another user. */

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion: vi.fn(),
}));
// No upload request log rows: a key's issuer comes from the issue record alone.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: async () => [] } }));

const { linkArticleContentImages } = await import('~/server/services/article.service');
const { recordUploadKeyOwner } = await import('~/server/services/image-url-ownership');

const AUTHOR = 7;
const EDITOR = 9;
const OTHER = 8;
const OWN_KEY = '0a0b0c0d-0000-4000-8000-0000000000aa';
const OTHERS_KEY = '0a0b0c0d-0000-4000-8000-0000000000bb';
const UNRECORDED_KEY = '0a0b0c0d-0000-4000-8000-0000000000cc';
const img = (key: string) =>
  `<img src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/a.jpeg">`;

const redis = new Map<string, string>();
const createManyAndReturn = vi.fn(async ({ data }: { data: { url: string }[] }) =>
  data.map((row, i) => ({ id: i + 1, url: row.url }))
);

beforeEach(() => {
  redis.clear();
  createManyAndReturn.mockClear();
  redisMock.sysRedis.set.mockImplementation((async (key: string, value: string) => {
    redis.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
  // No image rows anywhere.
  dbMock.dbWrite.image.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) =>
    cb({
      image: { findMany: async () => [], createManyAndReturn },
      imageConnection: { upsert: vi.fn(), findMany: async () => [], deleteMany: vi.fn() },
    })) as never);
});

const created = () =>
  createManyAndReturn.mock.calls.flatMap(([{ data }]) => data.map((r) => r.url));

const link = (content: string) =>
  linkArticleContentImages({ articleId: 1, content, userId: EDITOR, ownerId: AUTHOR });

describe('linkArticleContentImages', () => {
  it('creates no row for a key issued to another user, and rows for the rest', async () => {
    await recordUploadKeyOwner(OWN_KEY, AUTHOR);
    await recordUploadKeyOwner(OTHERS_KEY, OTHER);
    await link(`<p>${img(OWN_KEY)}${img(OTHERS_KEY)}${img(UNRECORDED_KEY)}</p>`);
    expect(created()).toEqual([OWN_KEY, UNRECORDED_KEY]);
  });

  it('creates a row for a key issued to the editor', async () => {
    await recordUploadKeyOwner(OTHERS_KEY, EDITOR);
    await link(`<p>${img(OTHERS_KEY)}</p>`);
    expect(created()).toEqual([OTHERS_KEY]);
  });

  it('checks every image of an article longer than one check takes', async () => {
    const keys = Array.from(
      { length: 70 },
      (_, i) => `0a0b0c0d-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    for (const key of keys) await recordUploadKeyOwner(key, OTHER);
    await recordUploadKeyOwner(OWN_KEY, AUTHOR);
    await link(`<p>${[...keys, OWN_KEY].map(img).join('')}</p>`);
    expect(created()).toEqual([OWN_KEY]);
  });
});
