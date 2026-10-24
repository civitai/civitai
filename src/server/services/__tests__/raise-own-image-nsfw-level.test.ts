import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as PostService from '~/server/services/post.service';

const { updatePostNsfwLevelMock } = vi.hoisted(() => ({ updatePostNsfwLevelMock: vi.fn() }));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  updatePostNsfwLevel: updatePostNsfwLevelMock,
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { raiseOwnImageNsfwLevel } from '~/server/services/image.service';

const IMAGE_ID = 7001;
const OWNER = 42;
const POST_ID = 9003;

function raiseUpdate() {
  const call = vi
    .mocked(dbMock.dbWrite.$queryRaw)
    .mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('UPDATE "Image"')
    );
  if (!call) return undefined;
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  const stmt = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return { text: stmt.text.replace(/\s+/g, ' '), values: stmt.values };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('raiseOwnImageNsfwLevel', () => {
  it('raises only the owner’s own, unlocked, scanned image, and only upward', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([{ postId: POST_ID }] as never);

    expect(
      await raiseOwnImageNsfwLevel({ id: IMAGE_ID, nsfwLevel: NsfwLevel.X, userId: OWNER })
    ).toBe(true);

    const { text, values } = raiseUpdate()!;
    expect(text).toContain('AND "userId" = $');
    expect(text).toContain('AND NOT "nsfwLevelLocked"');
    expect(text).toContain('AND ingestion = $');
    expect(text).toContain('AND "nsfwLevel" < $');
    // It must not lock: Knights and moderators still review the vote recorded alongside it.
    expect(text).not.toContain('nsfwLevelLocked" =');
    expect(values).toEqual(expect.arrayContaining([NsfwLevel.X, IMAGE_ID, OWNER, 'Scanned']));
    expect(updatePostNsfwLevelMock).toHaveBeenCalledWith(POST_ID);
  });

  it('reports nothing applied when no row matched (not the owner, locked, lower, or unscanned)', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([] as never);

    expect(
      await raiseOwnImageNsfwLevel({ id: IMAGE_ID, nsfwLevel: NsfwLevel.R, userId: OWNER })
    ).toBe(false);
    expect(updatePostNsfwLevelMock).not.toHaveBeenCalled();
  });

  it('never lets an owner set Blocked', async () => {
    expect(
      await raiseOwnImageNsfwLevel({ id: IMAGE_ID, nsfwLevel: NsfwLevel.Blocked, userId: OWNER })
    ).toBe(false);
    expect(raiseUpdate()).toBeUndefined();
  });
});
