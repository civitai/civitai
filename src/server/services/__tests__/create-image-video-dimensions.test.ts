import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { VideoDimensions } from '~/server/services/video-dimensions';

const { probeMock } = vi.hoisted(() => ({
  probeMock: vi.fn<(url: string) => Promise<VideoDimensions | null>>(),
}));

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
vi.mock('~/server/services/video-dimensions', () => ({ probeVideoDimensions: probeMock }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { createImage, fillVideoDimensions } from '~/server/services/image.service';

const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';
const CREATED_ID = 4242;

/** The UPDATE "Image" fillVideoDimensions wrote, as text + bound values. */
function dimensionWrite() {
  const call = vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('UPDATE "Image"')
    );
  if (!call) return undefined;
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...(values as Prisma.Sql[]));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: CREATED_ID } as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
});

describe('createImage — video dimensions', () => {
  it('writes the row first, then fills the dimensions without waiting on the probe', async () => {
    let answer!: (value: VideoDimensions) => void;
    probeMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    await createImage({ url: KEY, userId: 1, type: 'video', skipIngestion: true } as never);

    // The create returned while the probe was still pending.
    expect(dbMock.dbWrite.image.create.mock.calls[0][0].data).not.toHaveProperty('width', 640);
    expect(dimensionWrite()).toBeUndefined();

    answer({ width: 640, height: 1152, duration: 12.5 });
    await vi.waitFor(() => expect(dimensionWrite()).toBeDefined());
    expect(dimensionWrite()!.values).toEqual(expect.arrayContaining([640, 1152, 12.5, CREATED_ID]));
  });

  it.each([
    ['a video that already has dimensions', { type: 'video', width: 768, height: 1376 }],
    ['an image', { type: 'image' }],
  ])('does not probe %s', async (_label, over) => {
    await createImage({ url: KEY, userId: 1, skipIngestion: true, ...over } as never);

    expect(probeMock).not.toHaveBeenCalled();
  });
});

describe('fillVideoDimensions', () => {
  it('writes only to a row still missing dimensions, and keeps a recorded duration', async () => {
    probeMock.mockResolvedValue({ width: 640, height: 1152, duration: 12.5 });

    expect(await fillVideoDimensions({ id: CREATED_ID, url: KEY })).toEqual({
      width: 640,
      height: 1152,
      duration: 12.5,
    });

    const text = dimensionWrite()!.text.replace(/\s+/g, ' ');
    expect(text).toContain('WHERE id = $');
    expect(text).toContain('AND (width IS NULL OR height IS NULL)');
    expect(text).toContain(`WHEN metadata ? 'duration'`);
  });

  it('writes nothing when the probe has no answer', async () => {
    probeMock.mockResolvedValue(null);

    expect(await fillVideoDimensions({ id: CREATED_ID, url: KEY })).toBeNull();
    expect(dimensionWrite()).toBeUndefined();
  });

  it('reports nothing written when another writer filled the row first', async () => {
    probeMock.mockResolvedValue({ width: 640, height: 1152 });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0 as never);

    expect(await fillVideoDimensions({ id: CREATED_ID, url: KEY })).toBeNull();
  });
});
