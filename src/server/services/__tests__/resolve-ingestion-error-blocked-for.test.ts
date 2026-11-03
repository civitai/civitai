import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resolveIngestionError } from '~/server/services/image.service';

const IMAGE_ID = 4242;
// Not a bare-uuid key, so the missing-media probe is skipped and never reaches storage.
const UNPROBEABLE_URL = 'https://example.com/legacy.jpeg';

const resolve = () => resolveIngestionError({ id: IMAGE_ID, nsfwLevel: 1, userId: 7 });

function armImage(columns: {
  blockedFor?: string | null;
  needsReview?: string | null;
  user?: { bannedAt: Date | null; deletedAt: Date | null };
}) {
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    ingestion: 'Error',
    postId: null,
    userId: 99,
    metadata: {},
    url: UNPROBEABLE_URL,
    blockedFor: null,
    needsReview: null,
    user: { bannedAt: null, deletedAt: null },
    ...columns,
  } as never);
}

/** The DELETE of this image's pending blocked-image purge row, if one ran. */
const purgeRowDrops = () =>
  vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('"JobQueue"')
    );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe('resolveIngestionError and blockedFor', () => {
  it('clears a block the scan set, and drops its pending purge row', async () => {
    armImage({ blockedFor: 'a prompt audit reason' });

    await resolve();

    expect(dbMock.dbWrite.image.updateMany).toHaveBeenCalledTimes(1);
    const arg = dbMock.dbWrite.image.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      id: IMAGE_ID,
      blockedFor: 'a prompt audit reason',
      needsReview: null,
      user: { bannedAt: null, deletedAt: null },
    });
    expect(arg.data).toMatchObject({ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1 });
    const drops = purgeRowDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContainEqual([IMAGE_ID]);
  });

  it('leaves the purge queue alone when there was no block to clear', async () => {
    armImage({});

    await resolve();

    expect(dbMock.dbWrite.image.updateMany).toHaveBeenCalledTimes(1);
    expect(purgeRowDrops()).toHaveLength(0);
  });

  it.each([
    ['a CSAM block', { blockedFor: 'CSAM' }],
    ['a moderator block', { blockedFor: 'moderated' }],
    ['a moderator block in legacy casing', { blockedFor: ' Moderated ' }],
    ['a ToS block', { blockedFor: 'tos' }],
    ['an unverified-AI block', { blockedFor: 'AiNotVerified' }],
    ['a csam review hold with no block reason', { needsReview: 'csam' }],
    [
      'a csam review hold over a scan block',
      { blockedFor: 'a prompt audit reason', needsReview: 'csam' },
    ],
  ])('refuses %s and writes nothing', async (_label, columns) => {
    armImage(columns);

    await expect(resolve()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This image has a moderation block; resolve it from block review.',
    });

    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    expect(purgeRowDrops()).toHaveLength(0);
  });

  it.each([
    ['banned', { bannedAt: new Date(), deletedAt: null }],
    ['deleted', { bannedAt: null, deletedAt: new Date() }],
  ])('refuses an image whose owner is %s and writes nothing', async (_label, user) => {
    armImage({ blockedFor: 'a prompt audit reason', user });

    await expect(resolve()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: "This image's owner account is banned or deleted; it can't be published from here.",
    });

    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(purgeRowDrops()).toHaveLength(0);
  });

  it('refuses without dropping the purge row when the block changed after it was read', async () => {
    armImage({ blockedFor: 'a prompt audit reason' });
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(resolve()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(purgeRowDrops()).toHaveLength(0);
  });
});
