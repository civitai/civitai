import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `assertImageVisibleToViewer` reads through Kysely, not Prisma's `$queryRaw`. What its predicate
 * admits, against real rows, is pinned by the PGlite suites (image-detail-visibility.behavior and
 * its neighbours); this pins the executor and the row it hands back.
 */

const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);

const { assertImageVisibleToViewer } = await import('~/server/services/image-visibility.service');

// Pairwise distinct, and none equal to a level or a flag.
const IMAGE = 6101;
const OWNER = 6202;
const POST = 6303;
const LEVEL = 4;

beforeEach(() => {
  vi.clearAllMocks();
  kysely.read.mockReset();
  kysely.write.mockReset();
});

describe('assertImageVisibleToViewer', () => {
  it('reads the row through Kysely on the replica and returns it as read', async () => {
    kysely.read.mockResolvedValue([
      { id: IMAGE, userId: OWNER, nsfwLevel: LEVEL, postId: POST, visibleSignedOut: true },
    ]);

    await expect(
      assertImageVisibleToViewer({ id: IMAGE, isModerator: true, withSignedOutVerdict: true })
    ).resolves.toStrictEqual({
      id: IMAGE,
      userId: OWNER,
      nsfwLevel: LEVEL,
      postId: POST,
      visibleSignedOut: true,
    });

    expect(kysely.read).toHaveBeenCalledTimes(1);
    const [strings, ...values] = kysely.read.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('AS "visibleSignedOut"');
    expect(strings.join('?')).toContain('FROM "Image" i');
    expect(values).toContain(IMAGE);
    expect(kysely.write).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  // Prisma's raw read answered an id past int4 with no row, so NOT_FOUND. Through the pg pools the
  // same statement is a range error, a 500: the id is answered without the read.
  it('is NOT_FOUND, without a read, for an id past int4', async () => {
    const { rejectPastInt4 } = await import('~/test-utils/kysely-raw-fake');
    kysely.read.mockImplementation(async (_strings: readonly string[], ...values: unknown[]) => {
      rejectPastInt4(values);
      return [];
    });
    await expect(
      assertImageVisibleToViewer({ id: 2 ** 31, isModerator: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(kysely.read).not.toHaveBeenCalled();
  });

  it('is NOT_FOUND when the read finds no row', async () => {
    kysely.read.mockResolvedValue([]);
    await expect(
      assertImageVisibleToViewer({ id: IMAGE, isModerator: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
