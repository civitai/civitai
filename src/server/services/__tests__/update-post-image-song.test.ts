import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { POST_TITLE_MAX_LENGTH } from '~/server/common/constants';
import type * as Caches from '~/server/redis/caches';
import { updatePostImageSchema } from '~/server/schema/post.schema';
import type * as Blocklist from '~/server/services/blocklist.service';

const mocks = vi.hoisted(() => ({ throwOnBlockedUserContent: vi.fn() }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: mocks.throwOnBlockedUserContent,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  const refresh = vi.fn(async () => undefined);
  return {
    ...actual,
    imageMetadataCache: { ...actual.imageMetadataCache, refresh },
    imageMetaCache: { ...actual.imageMetaCache, refresh },
    userPostCountCache: { ...actual.userPostCountCache, refresh },
  };
});

import { updatePostImage } from '~/server/services/post.service';

const IMAGE_ID = 9;
const stored = { duration: 120, bpm: 90, title: 'Old title' };

function wireImage(type: 'audio' | 'image' | 'video', metadata: object = stored) {
  dbMock.dbWrite.image.findUniqueOrThrow.mockResolvedValue({
    type,
    hideMeta: false,
    ingestion: 'Scanned',
    blockedFor: null,
    metadata,
    nsfwLevel: 1,
    meta: null,
  } as never);
  dbMock.dbWrite.image.update.mockResolvedValue({ id: IMAGE_ID, url: 'u', userId: 5 } as never);
}

/** Through the procedure's own input schema, as the router hands it over. */
const update = (input: Record<string, unknown>) =>
  updatePostImage(updatePostImageSchema.parse({ id: IMAGE_ID, ...input }));

function written() {
  expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  return dbMock.dbWrite.image.update.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.throwOnBlockedUserContent.mockResolvedValue(undefined);
});

describe("updatePostImage — a song's title and remix setting", () => {
  it('stores the trimmed title in the song metadata, keeping its other fields', async () => {
    wireImage('audio');

    await update({ title: '  Night Drive  ' });

    const data = written();
    expect(data.metadata).toEqual({ ...stored, title: 'Night Drive' });
    // Not an Image column: Prisma rejects an update that names one.
    expect(data).not.toHaveProperty('title');
  });

  it('clears the title when it is emptied', async () => {
    wireImage('audio');

    await update({ title: '   ' });

    expect(written().metadata).toEqual({ duration: 120, bpm: 90 });
  });

  it('refuses a title longer than a post title', () => {
    expect(() => update({ title: 'x'.repeat(POST_TITLE_MAX_LENGTH + 1) })).toThrow();
  });

  it('refuses a title the blocked-content check rejects, writing nothing', async () => {
    wireImage('audio');
    mocks.throwOnBlockedUserContent.mockRejectedValue(new Error('blocked'));

    await expect(update({ title: 'bad words' })).rejects.toThrow('blocked');
    expect(mocks.throwOnBlockedUserContent).toHaveBeenCalledWith('bad words', expect.anything());
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('stores allowRemix: false in the song metadata', async () => {
    wireImage('audio');

    await update({ allowRemix: false });

    const data = written();
    expect(data.metadata).toEqual({ ...stored, allowRemix: false });
    expect(data).not.toHaveProperty('allowRemix');
  });

  it.each(['image', 'video'] as const)(
    'refuses a title or remix setting on an %s',
    async (type) => {
      wireImage(type, { width: 1, height: 1 });

      await expect(update({ title: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(update({ allowRemix: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    }
  );

  it('updates an image as before when neither field is sent', async () => {
    const metadata = { width: 1, height: 1, title: 'kept' };
    wireImage('image', metadata);

    await update({ hideMeta: true });

    const data = written();
    expect(data.metadata).toEqual(metadata);
    expect(data.hideMeta).toBe(true);
    expect(mocks.throwOnBlockedUserContent).not.toHaveBeenCalled();
  });
});
