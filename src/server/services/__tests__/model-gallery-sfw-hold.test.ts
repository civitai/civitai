import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  bustModelGallerySettings: vi.fn(),
  getCreatorGalleryHiddenUserIds: vi.fn(async () => []),
}));

const { getGallerySettingsByModelId } = await import('~/server/services/model.service');

/**
 * A minor or SFW-only model's gallery serves the levels its stored setting allows, within SFW
 * (1 = PG, 2 = PG13), whatever the stored setting says: a missing level, 0, or one with no SFW
 * level in it, serves SFW. The gallery reads a level of 0 as no cap at all.
 */

const MODEL = 7;
const SFW = 3;

function stored(row: { minor?: boolean; sfwOnly?: boolean; gallerySettings: unknown }) {
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.model.findFirst.mockResolvedValue({
      id: MODEL,
      userId: 1,
      minor: false,
      sfwOnly: false,
      ...row,
    } as never);
}

const servedLevel = async () => (await getGallerySettingsByModelId({ id: MODEL }))?.level;

beforeEach(() => {
  vi.clearAllMocks();
  // A cache miss unless a test caches something; a cached value would otherwise carry over.
  redisMock.redis.get.mockResolvedValue(null);
});

describe('getGallerySettingsByModelId — the SFW hold on a flagged model', () => {
  it.each([
    ['R only', 4, SFW],
    ['PG and R', 5, 1],
    ['PG, PG13 and R', 7, SFW],
    ['SFW', 3, SFW],
    ['0', 0, SFW],
  ])('serves %s stored on a minor model as its SFW part', async (_name, level, served) => {
    stored({ minor: true, gallerySettings: { level } });
    expect(await servedLevel()).toBe(served);
  });

  it('serves SFW when the stored setting has no level', async () => {
    stored({ minor: true, gallerySettings: { users: [], tags: [] } });
    expect(await servedLevel()).toBe(SFW);
  });

  it('serves SFW when nothing is stored', async () => {
    stored({ sfwOnly: true, gallerySettings: null });
    expect(await servedLevel()).toBe(SFW);
  });

  it('holds an SFW-only model the same way', async () => {
    stored({ sfwOnly: true, gallerySettings: { level: 31 } });
    expect(await servedLevel()).toBe(SFW);
  });

  it("serves an unflagged model's stored level as it is", async () => {
    stored({ gallerySettings: { level: 31 } });
    expect(await servedLevel()).toBe(31);
  });

  it("serves an unflagged model's stored 0 as it is", async () => {
    stored({ gallerySettings: { level: 0 } });
    expect(await servedLevel()).toBe(0);
  });

  it('serves every level on an unflagged model with no stored level', async () => {
    stored({ gallerySettings: { users: [] } });
    expect(await servedLevel()).toBe(allBrowsingLevelsFlag);
  });

  it('says whether the hold is in force', async () => {
    stored({ minor: true, gallerySettings: { level: 31 } });
    expect((await getGallerySettingsByModelId({ id: MODEL }))?.sfwHeld).toBe(true);
    stored({ gallerySettings: { level: 31 } });
    expect((await getGallerySettingsByModelId({ id: MODEL }))?.sfwHeld).toBe(false);
  });
});

// Entries cached before the hold carry no `sfwHeld`, and a null among them cannot say whether the
// model is flagged; each is rebuilt from the model rather than served.
describe('getGallerySettingsByModelId — entries cached before the SFW hold', () => {
  const cachedAs = (value: unknown) => redisMock.redis.get.mockResolvedValue(JSON.stringify(value));
  const readModel = () =>
    dbMock.dbRead.model.findFirst.mock.calls.length +
    dbMock.dbWrite.model.findFirst.mock.calls.length;

  it('rebuilds a cached object without the hold', async () => {
    stored({ minor: true, gallerySettings: { level: 31 } });
    cachedAs({ level: 31, hiddenImages: {}, hiddenTags: [], hiddenUsers: [], pinnedPosts: {} });
    expect(await servedLevel()).toBe(SFW);
  });

  it('rebuilds a cached null', async () => {
    stored({ sfwOnly: true, gallerySettings: null });
    cachedAs(null);
    expect(await servedLevel()).toBe(SFW);
  });

  it('serves an entry cached with the hold without reading the model', async () => {
    cachedAs({
      level: 1,
      hiddenImages: {},
      hiddenTags: [],
      hiddenUsers: [],
      pinnedPosts: {},
      sfwHeld: true,
    });
    expect(await servedLevel()).toBe(1);
    expect(readModel()).toBe(0);
  });

  it('serves no settings for a model cached with none, without reading the model', async () => {
    stored({ gallerySettings: null });
    await getGallerySettingsByModelId({ id: MODEL });
    const marker = redisMock.redis.set.mock.calls[0][1];
    vi.clearAllMocks();
    redisMock.redis.get.mockResolvedValue(marker as never);

    expect(await getGallerySettingsByModelId({ id: MODEL })).toBeNull();
    expect(readModel()).toBe(0);
  });
});
