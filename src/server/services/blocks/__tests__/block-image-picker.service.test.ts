import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

import { getBlockPickablePostedImages } from '~/server/services/blocks/block-image-picker.service';

const key = (n: number) => `00000000-0000-4000-8000-0000000000${n}`;

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  url: key(id),
  width: 1216,
  height: 832,
  nsfwLevel: 4,
  ...over,
});

describe('getBlockPickablePostedImages', () => {
  beforeEach(() => {
    dbMock.dbRead.image.findMany.mockReset();
  });

  it("queries the caller's pickable images newest first, one row past the page", async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);

    await getBlockPickablePostedImages({ userId: 8123, browsingLevel: 12, limit: 3 });

    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(1);
    const args = dbMock.dbRead.image.findMany.mock.calls[0][0];
    expect(args.take).toBe(4);
    expect(args.cursor).toBeUndefined();
    expect(args.orderBy).toEqual({ id: 'desc' });
    expect(args.where).toMatchObject({
      userId: 8123,
      type: 'image',
      ingestion: 'Scanned',
      poi: false,
      minor: false,
      needsReview: null,
      tosViolation: false,
      nsfwLevel: { in: [4, 8] },
    });
    expect(args.where.post.publishedAt.lte).toBeInstanceOf(Date);
  });

  it('pages by id: a full page reports the next row as the cursor and does not return it', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([row(44), row(33), row(22)]);

    const page = await getBlockPickablePostedImages({
      userId: 8123,
      browsingLevel: 12,
      limit: 2,
      cursor: 55,
    });

    expect(dbMock.dbRead.image.findMany.mock.calls[0][0].cursor).toEqual({ id: 55 });
    expect(page.items.map((i) => i.imageId)).toEqual([44, 33]);
    expect(page.nextCursor).toBe(22);
  });

  it('reports no cursor on the last page', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([row(44), row(33)]);

    const page = await getBlockPickablePostedImages({ userId: 8123, browsingLevel: 12, limit: 2 });

    expect(page.items.map((i) => i.imageId)).toEqual([44, 33]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('returns the projected pick, not the row', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([row(44)]);

    const page = await getBlockPickablePostedImages({ userId: 8123, browsingLevel: 12, limit: 2 });

    expect(page.items).toEqual([
      {
        imageId: 44,
        key: key(44),
        url: `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key(44)}/width=1200/${key(
          44
        )}.jpeg`,
        width: 1200,
        height: 821,
        nsfwLevel: 4,
      },
    ]);
  });

  it('drops a row no rendition fits, and still reports the cursor', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([
      row(66, { width: 5000, height: 1 }),
      row(55),
      row(44, { width: 100, height: 3000 }),
      row(33),
    ]);

    const page = await getBlockPickablePostedImages({ userId: 8123, browsingLevel: 12, limit: 3 });

    expect(page.items.map((i) => i.imageId)).toEqual([55]);
    expect(page.nextCursor).toBe(33);
  });
});
