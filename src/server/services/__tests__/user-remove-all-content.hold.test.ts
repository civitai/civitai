import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `removeAllContent` on an owner under a hold marker. The image delete would skip every row, so
 * the wipe must not attempt it (one log line, not one failure per image) and must tell its caller
 * how many images it kept, or a partial wipe reads as complete.
 */

const { deleteImageById } = vi.hoisted(() => ({
  deleteImageById: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({
    wipeAccount: async () => ({ namespaces: [], failures: [] }),
  }),
}));
vi.mock('~/server/services/apps/user-storage-purge.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  purgeUserAppStorageForAccountWipe: vi.fn(async ({ targetUserId }: { targetUserId: number }) => ({
    userId: targetUserId,
    purgeBatchId: 'apg_test',
    results: [],
    failures: [],
    unmappedSchemas: [],
    schemasTruncated: false,
    totals: { appCount: 0, deletedRowCount: 0, deletedBytes: 0 },
  })),
}));
vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const idx = { queueUpdate: vi.fn(async () => undefined) };
  return {
    ...actual,
    modelsSearchIndex: idx,
    imagesSearchIndex: idx,
    imagesMetricsSearchIndex: idx,
    articlesSearchIndex: idx,
    collectionsSearchIndex: idx,
    bountiesSearchIndex: idx,
    usersSearchIndex: idx,
  };
});
vi.mock('~/server/metrics', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const m = { queueUpdate: vi.fn(async () => undefined) };
  return { ...actual, userMetrics: m, articleMetrics: m };
});
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImageById,
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteBidsForModel: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { removeAllContent } from '~/server/services/user.service';

const TARGET = 4_242;
const IMAGES = [
  { id: 1, url: 'a' },
  { id: 2, url: 'b' },
  { id: 3, url: 'c' },
];

/** Answers the hold lookup; every other raw query gets the mock's default empty result. */
function holdIs(held: boolean) {
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) =>
    strings.join('?').includes('"EvidenceHeldUser"') ? [{ held }] : []) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.dbRead) as { findMany?: ReturnType<typeof vi.fn> }[]) {
    if (model && typeof model === 'object' && 'findMany' in model)
      model.findMany?.mockResolvedValue([]);
  }
  vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue(IMAGES as never);
});

const imageDeletesForTarget = () =>
  vi
    .mocked(dbMock.dbWrite.image.deleteMany)
    .mock.calls.filter(
      ([args]) => (args as { where?: { userId?: number } })?.where?.userId === TARGET
    );

describe('removeAllContent on an owner under a hold marker', () => {
  it('keeps the images, logs one line, and reports how many it kept', async () => {
    holdIs(true);

    const result = await removeAllContent({ id: TARGET, actorUserId: 9 });

    expect(result).toEqual({ keptUnderHold: IMAGES.length });
    expect(deleteImageById).not.toHaveBeenCalled();
    expect(imageDeletesForTarget()).toEqual([]);
    const holdLines = vi
      .mocked(loggingMock.logToAxiom)
      .mock.calls.filter(
        ([entry]) => (entry as { message?: string }).message === 'Kept images under a hold'
      );
    expect(holdLines).toEqual([
      [
        expect.objectContaining({
          type: 'info',
          userId: TARGET,
          count: IMAGES.length,
        }),
      ],
    ]);
  });

  // The control: the same wipe of an owner with no hold deletes every image.
  it('deletes every image of an owner with no hold', async () => {
    holdIs(false);

    const result = await removeAllContent({ id: TARGET, actorUserId: 9 });

    expect(result).toEqual({ keptUnderHold: 0 });
    expect(deleteImageById.mock.calls.map(([args]) => (args as { id: number }).id)).toEqual([
      1, 2, 3,
    ]);
    expect(imageDeletesForTarget()).toHaveLength(1);
  });
});
