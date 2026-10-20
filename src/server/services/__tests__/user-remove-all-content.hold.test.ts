import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `removeAllContent` on an owner under a hold marker. The image deletes still run: the hold's
 * delete trigger keeps each row (blocked, out of its post) instead, so the wipe takes the images off
 * the site either way. It must run them before the posts go, or the trigger can no longer record
 * which post an image was in, must never delete a kept image's stored file, and must tell its caller
 * what the hold kept (the posts are copied by their own delete trigger), or a partial wipe reads as
 * complete.
 */

const { deleteImageById, actual, storage } = vi.hoisted(() => ({
  deleteImageById: vi.fn(async (_args: { id: number }) => undefined as unknown),
  actual: { deleteImageById: null as unknown as (args: { id: number }) => Promise<unknown> },
  storage: { deletedKeys: [] as string[] },
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
  return { ...actual, userMetrics: m, articleMetrics: m, postMetrics: m };
});
vi.mock('~/server/services/image.service', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  actual.deleteImageById = mod.deleteImageById as typeof actual.deleteImageById;
  return { ...mod, deleteImageById };
});
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteBidsForModel: vi.fn(async () => undefined),
}));
// The stored-file delete, captured by key: the only place a file leaves storage.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getB2ImageS3Client: () => ({
    send: async (command: { input: { Key: string } }) => {
      storage.deletedKeys.push(command.input.Key);
      return {};
    },
  }),
}));
vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: async () => ({ backend: 'b2Image' }),
  registerMediaLocation: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { removeAllContent } from '~/server/services/user.service';

const TARGET = 4_242;
/** Held, and not the account being wiped: a lookup keyed on the wrong user would find this one. */
const OTHER_HELD = 4_277;
/** The target's posts, as the post delete reports them. */
const POSTS = 3;
const IMAGES = [
  { id: 1, url: 'a' },
  { id: 2, url: 'b' },
  { id: 3, url: 'c' },
];

let held: number[] = [];

/** Answers the hold lookup from the user it binds; every other raw query gets an empty result. */
function heldUsers(...userIds: number[]) {
  held = userIds;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    strings.join('?').includes('"EvidenceHeldUser"')
      ? [{ held: values.some((v) => userIds.includes(v as number)) }]
      : []) as never);
}

/**
 * The image delete as Postgres answers it with the hold's trigger installed: a held owner's row is
 * kept, so the single-row DELETE returns nothing and Prisma reports P2025 (observed against a real
 * Postgres 16 with this migration applied). Any other row comes back.
 */
function deleteAsTheTriggerDoes() {
  vi.mocked(dbMock.dbWrite.image.delete).mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const image = IMAGES.find((i) => i.id === where.id);
    if (!image || held.includes(TARGET))
      throw new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'x',
      });
    return { ...image, postId: null, nsfwLevel: 1, userId: TARGET, metadata: {} };
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.deletedKeys = [];
  vi.mocked(dbMock.dbWrite.post.deleteMany).mockImplementation((async ({
    where,
  }: {
    where: { userId: number };
  }) => ({ count: where.userId === TARGET ? POSTS : 0 })) as never);
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
  it('runs every image delete before the posts go, and reports what the hold kept', async () => {
    heldUsers(TARGET);

    // No actor, as the webhook caller passes: the lookup must be keyed on the account, not on it.
    const result = await removeAllContent({ id: TARGET });

    expect(result).toEqual({ keptUnderHold: IMAGES.length, keptPostsUnderHold: POSTS });
    expect(deleteImageById.mock.calls.map(([args]) => args.id)).toEqual([1, 2, 3]);
    expect(imageDeletesForTarget()).toHaveLength(1);
    const postDelete = vi.mocked(dbMock.dbWrite.post.deleteMany).mock.invocationCallOrder[0];
    expect(postDelete).toBeGreaterThan(Math.max(...deleteImageById.mock.invocationCallOrder));
    expect(postDelete).toBeGreaterThan(
      vi.mocked(dbMock.dbWrite.image.deleteMany).mock.invocationCallOrder[0]
    );
  });

  // The control: the same wipe of an owner with no hold, while someone else is held.
  it('reports nothing kept for an owner with no hold', async () => {
    heldUsers(OTHER_HELD);

    const result = await removeAllContent({ id: TARGET, actorUserId: 9 });

    expect(result).toEqual({ keptUnderHold: 0, keptPostsUnderHold: 0 });
    expect(deleteImageById.mock.calls.map(([args]) => args.id)).toEqual([1, 2, 3]);
    expect(imageDeletesForTarget()).toHaveLength(1);
  });

  describe('stored files', () => {
    beforeEach(() => {
      deleteImageById.mockImplementation((args) => actual.deleteImageById(args));
      deleteAsTheTriggerDoes();
      setEnv({ DATABASE_IS_PROD: true });
    });

    it("never deletes a kept image's file", async () => {
      heldUsers(TARGET);
      try {
        await removeAllContent({ id: TARGET });
      } finally {
        setEnv({ DATABASE_IS_PROD: false });
      }

      expect(storage.deletedKeys).toEqual([]);
    });

    // The control: the same wipe deletes every file when the rows are deleted.
    it('deletes the file of every image it deleted', async () => {
      heldUsers(OTHER_HELD);
      try {
        await removeAllContent({ id: TARGET });
      } finally {
        setEnv({ DATABASE_IS_PROD: false });
      }

      expect(storage.deletedKeys.sort()).toEqual(['a', 'b', 'c']);
    });
  });
});
