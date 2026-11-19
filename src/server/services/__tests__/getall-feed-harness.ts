import { vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * One model (MODEL, owned by OWNER, one published version VERSION) for tests that drive
 * `getModelsWithImagesAndModelVersions`. Each test file wires the modules it needs with
 * `vi.mock('<specifier>', async (importOriginal) => (await import('./getall-feed-harness')).<module>(importOriginal))`
 * so the stand-ins live here once, and calls `stubPackedRedis()` and `resetModelRow()`.
 */

export const OWNER = 7;
export const MODEL = 100;
export const VERSION = 200;

/** The model row the feed query returns; set its flags per test, reset in `beforeEach`. */
export const modelRow = { nsfw: false, minor: false, sfwOnly: false };
export const resetModelRow = () =>
  Object.assign(modelRow, { nsfw: false, minor: false, sfwOnly: false });

export const stubPackedRedis = () => {
  redisMock.redis.packed.get.mockImplementation(async () => null);
  redisMock.redis.packed.set.mockImplementation(async () => undefined);
};

type CardImageOverrides = Partial<{
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
  tags: number[];
}>;

/** A showcase image of VERSION posted by OWNER: PG, untagged, unless overridden. */
export const cardImage = (id: number, overrides: CardImageOverrides = {}) => ({
  id,
  userId: OWNER,
  modelVersionId: VERSION,
  nsfwLevel: NsfwLevel.PG,
  url: `u${id}`,
  hash: `h${id}`,
  poi: false,
  minor: false,
  tags: [] as number[],
  ...overrides,
});

type ImportOriginal = <T = object>() => Promise<T>;

export const imageServiceModule = () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
});

export const fliptClientModule = () => ({
  isFlipt: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
});

/**
 * The rows the feed query returns. pgDb itself stays an inline literal in each suite (its export
 * set is checked by pgDbMock.parity.test.ts); only `cancellableQuery`'s answer comes from here.
 */
export const feedModelRows = () => [
  {
    id: MODEL,
    userId: OWNER,
    name: 'model',
    type: 'LORA',
    nsfw: modelRow.nsfw,
    minor: modelRow.minor,
    sfwOnly: modelRow.sfwOnly,
    nsfwLevel: 31,
    status: 'Published',
    mode: null,
    rank: {},
    meta: null,
    cursorId: null,
  },
];

export const cachesModule = async (importOriginal: ImportOriginal) => ({
  ...(await importOriginal()),
  userBasicCache: { fetch: vi.fn(async () => ({ [OWNER]: { username: 'owner' } })) },
  dataForModelsCache: {
    fetch: vi.fn(async () => ({
      [MODEL]: {
        versions: [
          {
            id: VERSION,
            status: 'Published',
            availability: 'Public',
            nsfwLevel: 31,
            baseModel: 'SDXL 1.0',
            flags: 0,
          },
        ],
        tags: [],
        hashes: [],
      },
    })),
  },
});

export const userServiceModule = async (importOriginal: ImportOriginal) => ({
  ...(await importOriginal()),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
});

export const cosmeticServiceModule = async (importOriginal: ImportOriginal) => ({
  ...(await importOriginal()),
  getCosmeticsForEntity: vi.fn(async () => ({})),
  getEventDecorationsForEntity: vi.fn(async () => ({})),
});

export const paidAccessServiceModule = async (importOriginal: ImportOriginal) => ({
  ...(await importOriginal()),
  getModelPaidAccessGates: vi.fn(async () => new Map()),
});

export const modelCoverServiceModule = () => ({
  getCoverImages: vi.fn(async () => new Map()),
});

export const coverageSourceModule = async (importOriginal: ImportOriginal) => ({
  ...(await importOriginal()),
  nextCoverageEnabled: vi.fn(async () => false),
});
