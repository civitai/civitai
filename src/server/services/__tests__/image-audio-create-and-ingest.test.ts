import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';

const { mockCreateImageIngestionRequest } = vi.hoisted(() => ({
  mockCreateImageIngestionRequest: vi.fn(),
}));

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createImageIngestionRequest: mockCreateImageIngestionRequest,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createEntityImages,
  createImage,
  ingestImage,
  updateEntityImages,
} from '~/server/services/image.service';

const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: 4242 } as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
});

describe('createImage — audio', () => {
  it('refuses a song unless the caller vouches for it, so no other create path can store one', async () => {
    await expect(
      createImage({ url: KEY, userId: 1, type: 'audio', skipIngestion: true } as never)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  });

  it('stores a song the caller vouches for', async () => {
    await createImage({
      url: KEY,
      userId: 1,
      type: 'audio',
      allowAudio: true,
      skipIngestion: true,
    } as never);
    expect(dbMock.dbWrite.image.create.mock.calls[0][0].data).toMatchObject({ type: 'audio' });
  });
});

describe('ingestImage — audio', () => {
  const song = { id: 4242, url: KEY, type: 'audio' as never, width: null, height: null };

  it('submits the song for its scan and stamps the row like any other scan', async () => {
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: { id: 'wf-song' },
      useImageScanning: false,
    });

    const sent = await ingestImage({ image: song });

    expect(sent).toBe(true);
    expect(mockCreateImageIngestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 4242, type: 'audio' })
    );
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('reports a song the orchestrator did not take as unsent and records the failure for the retry', async () => {
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: undefined,
      status: 503,
      useImageScanning: false,
    });

    const sent = await ingestImage({ image: song });

    expect(sent).toBe(false);
    // The failure is recorded for the cron's retry, not written as a scan request.
    const [, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
    expect(values.some((v) => typeof v === 'string' && v.includes('send-fail'))).toBe(true);
  });
});

describe('ingestImage — a song whose submit throws', () => {
  const song = { id: 4242, url: KEY, type: 'audio' as never, width: null, height: null };

  it('still records the attempt, so the cron does not re-send it every run without limit', async () => {
    mockCreateImageIngestionRequest.mockRejectedValue(new Error('connection reset'));

    const sent = await ingestImage({ image: song });

    expect(sent).toBe(false);
    const [, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
    expect(values.some((v) => v instanceof Date)).toBe(true);
    expect(values.some((v) => typeof v === 'string' && v.includes('send-fail'))).toBe(true);
  });
});

describe('entity image writes — audio', () => {
  const song = { url: KEY, type: 'audio' } as never;

  it('createEntityImages refuses a song without writing it', async () => {
    await expect(createEntityImages({ images: [song], userId: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(dbMock.dbWrite.image.createMany).not.toHaveBeenCalled();
  });

  it('createEntityImages inserts every entry, so a song carrying an id is refused too', async () => {
    const withId = { url: KEY, type: 'audio', id: 5 } as never;
    await expect(createEntityImages({ images: [withId], userId: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(dbMock.dbWrite.image.createMany).not.toHaveBeenCalled();
  });

  it('updateEntityImages refuses a new song without writing it', async () => {
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
    await expect(
      updateEntityImages({ entityId: 1, entityType: 'Bounty', images: [song], userId: 1 })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.image.createMany).not.toHaveBeenCalled();
  });

  it('updateEntityImages still links a song the owner already has: an id is linked, not inserted', async () => {
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
    dbMock.dbWrite.image.count.mockResolvedValue(1 as never);
    const existing = { url: KEY, type: 'audio', id: 5 } as never;
    await updateEntityImages({ entityId: 1, entityType: 'Bounty', images: [existing], userId: 1 });
    expect(dbMock.dbWrite.image.createMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageConnection.createMany).toHaveBeenCalledWith({
      data: [{ imageId: 5, entityId: 1, entityType: 'Bounty' }],
    });
  });
});
