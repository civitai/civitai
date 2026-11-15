import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockUpdateModelById,
  mockPurgeHeldShowcase,
  mockQueueUpdate,
  mockCollectionsReindex,
  mockArticlesReindex,
} = vi.hoisted(() => ({
  mockUpdateModelById: vi.fn(),
  mockPurgeHeldShowcase: vi.fn(),
  mockQueueUpdate: vi.fn(async () => undefined),
  mockCollectionsReindex: vi.fn(async () => undefined),
  mockArticlesReindex: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/article-cover-reindex', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueModelArticlesReindex: mockArticlesReindex,
}));
vi.mock('~/server/services/collection-index-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueModelCollectionsReindex: mockCollectionsReindex,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  modelsSearchIndex: { queueUpdate: mockQueueUpdate },
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateModelById: mockUpdateModelById,
  purgeHeldShowcase: mockPurgeHeldShowcase,
}));
vi.mock('~/server/services/creator-gallery-hidden-users.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustModelGallerySettings: vi.fn(async () => undefined),
}));

const { updateGallerySettingsHandler } = await import('../model.controller');

const MODEL = 1;
const OWNER = 5;
const MOD = 9;

type Row = { minor: boolean; sfwOnly: boolean; gallerySettings: { level?: number } | null };

// Runs the handler's write builder against `row`, as updateModelById does under its lock.
function save(row: Row, level: number) {
  mockUpdateModelById.mockImplementation(async ({ data }) => {
    data({ id: MODEL, userId: OWNER, ...row });
    return { id: MODEL, userId: OWNER, name: 'm' };
  });
  return updateGallerySettingsHandler({
    input: {
      id: MODEL,
      gallerySettings: {
        hiddenImages: {},
        hiddenUsers: [],
        hiddenTags: [],
        level,
        pinnedPosts: {},
      },
    },
    ctx: { user: { id: MOD, isModerator: true, username: 'mod' } },
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('updateGallerySettingsHandler — public showcase caches and search document', () => {
  it.each([
    ['minor', { minor: true, sfwOnly: false }],
    ['SFW-only', { minor: false, sfwOnly: true }],
  ])('purges them when a moderator changes the gallery level of a %s model', async (_n, flags) => {
    await save({ ...flags, gallerySettings: { level: 3 } }, 1);
    expect(mockPurgeHeldShowcase).toHaveBeenCalledTimes(1);
    expect(mockPurgeHeldShowcase).toHaveBeenCalledWith(MODEL);
    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
    expect(mockQueueUpdate).toHaveBeenCalledWith([{ id: MODEL, action: 'Update' }]);
    expect(mockCollectionsReindex).toHaveBeenCalledTimes(1);
    expect(mockCollectionsReindex).toHaveBeenCalledWith([MODEL]);
    expect(mockArticlesReindex).toHaveBeenCalledWith(MODEL);
  });

  it('leaves them when the level of a held model is unchanged', async () => {
    await save({ minor: true, sfwOnly: false, gallerySettings: { level: 1 } }, 1);
    expect(mockPurgeHeldShowcase).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(mockCollectionsReindex).not.toHaveBeenCalled();
    expect(mockArticlesReindex).not.toHaveBeenCalled();
  });

  it('leaves them when the model is not held', async () => {
    await save({ minor: false, sfwOnly: false, gallerySettings: { level: 3 } }, 1);
    expect(mockPurgeHeldShowcase).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(mockCollectionsReindex).not.toHaveBeenCalled();
    expect(mockArticlesReindex).not.toHaveBeenCalled();
  });
});
