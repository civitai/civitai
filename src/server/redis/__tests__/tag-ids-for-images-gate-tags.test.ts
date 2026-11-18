import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { childBrowsingTagIds } from '@civitai/shared';
import type * as SystemCache from '~/server/services/system-cache';
import { NsfwLevel } from '~/server/common/enums';

/**
 * tagIdsForImagesCache drops a Rekognition label from an image WD14 also tagged. The ids it keeps
 * are what card-image and feed filters read, so a label a browsing rule hides content by must stay.
 * Through the real cache definition, cache cluster faked, database mocked. Each case uses its own
 * image ids: the cache and its L1 are one module-level instance for the file.
 */

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBlockedBrowsingTags: vi.fn(),
  getBrowsingSettingAddons: vi.fn(),
}));

const { getBlockedBrowsingTags, getBrowsingSettingAddons } = await import(
  '~/server/services/system-cache'
);
const { DEFAULT_BROWSING_SETTINGS_ADDONS } = await import(
  '~/shared/constants/browsing-settings-addons'
);
const { tagIdsForImagesCache } = await import('~/server/redis/caches');
const { getShowcaseImageFilter } = await import('~/server/services/blocked-browsing-tags.service');

const CHILD = childBrowsingTagIds[0];
const WD14_TAG = 9001;
const OTHER_LABEL = 9002; // a Rekognition label no browsing rule names
const BLOCKED = 9003; // a blocked browsing tag
const LIVE_ONLY = 9004; // named only by a live addon, not the defaults
const R_LEVEL = NsfwLevel.R;

type Row = { imageId: number; tagId: number; source: 'WD14' | 'Rekognition' | 'User' };
let rows: Row[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  rows = [];
  vi.mocked(getBlockedBrowsingTags).mockResolvedValue([{ id: BLOCKED, name: 'blocked' }]);
  vi.mocked(getBrowsingSettingAddons).mockResolvedValue([
    ...DEFAULT_BROWSING_SETTINGS_ADDONS,
    { type: 'some', nsfwLevels: [NsfwLevel.R], excludedTagIds: [LIVE_ONLY] },
  ]);
  dbMock.dbRead.$queryRaw.mockImplementation((async (_strings: unknown, ids: number[]) =>
    rows.filter((r) => ids.includes(r.imageId))) as never);
  dbMock.dbRead.tag.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) =>
    args.where.id.in.map((id) => ({
      id,
      name: `tag-${id}`,
      nsfwLevel: 1,
      type: 'Label',
      unlisted: false,
    }))) as never);
});

const tagsOf = async (imageId: number) =>
  (await tagIdsForImagesCache.fetch([imageId]))[imageId]?.tags;

describe('tagIdsForImagesCache keeps labels a browsing rule hides by', () => {
  it('keeps a child label from Rekognition on an image WD14 also tagged', async () => {
    rows = [
      { imageId: 101, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 101, tagId: CHILD, source: 'Rekognition' },
    ];
    expect(await tagsOf(101)).toEqual(expect.arrayContaining([WD14_TAG, CHILD]));
  });

  it('keeps a blocked browsing tag from Rekognition on an image WD14 also tagged', async () => {
    rows = [
      { imageId: 102, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 102, tagId: BLOCKED, source: 'Rekognition' },
    ];
    expect(await tagsOf(102)).toEqual(expect.arrayContaining([WD14_TAG, BLOCKED]));
  });

  it('still drops a Rekognition label no rule names when WD14 tagged the image', async () => {
    rows = [
      { imageId: 103, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 103, tagId: OTHER_LABEL, source: 'Rekognition' },
    ];
    expect(await tagsOf(103)).toEqual([WD14_TAG]);
  });

  it('keeps every label when the browsing rules cannot be read', async () => {
    vi.mocked(getBlockedBrowsingTags).mockRejectedValue(new Error('down'));
    rows = [
      { imageId: 104, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 104, tagId: OTHER_LABEL, source: 'Rekognition' },
    ];
    expect(await tagsOf(104)).toEqual(expect.arrayContaining([WD14_TAG, OTHER_LABEL]));
  });

  it('a signed-out card-image filter at R hides child- and live-rule-labelled images and shows a plain one', async () => {
    rows = [
      { imageId: 105, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 105, tagId: CHILD, source: 'Rekognition' },
      { imageId: 106, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 107, tagId: WD14_TAG, source: 'WD14' },
      { imageId: 107, tagId: LIVE_ONLY, source: 'Rekognition' },
    ];
    const tags = await tagIdsForImagesCache.fetch([105, 106, 107]);
    const shows = await getShowcaseImageFilter({ browsingLevel: R_LEVEL });
    expect(shows({ userId: 1, tags: tags[105]?.tags })).toBe(false);
    expect(shows({ userId: 1, tags: tags[107]?.tags })).toBe(false);
    expect(shows({ userId: 1, tags: tags[106]?.tags })).toBe(true);
  });
});
