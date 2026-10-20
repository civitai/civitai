import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createImageIngestionRequest: vi.fn(async () => ({ data: { id: 'wf' } })),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { createImage } from '~/server/services/image.service';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';

const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: 4242 } as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
});

const create = (over: Record<string, unknown> = {}) =>
  createImage({ url: KEY, userId: 7, type: 'image', ...over } as never);
const createdData = () => dbMock.dbWrite.image.create.mock.calls[0][0].data;

describe('createImage for an owner', () => {
  it('who is banned stores the image blocked and still sends it to scan', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date() } as never);

    await create();

    // The mock answers whatever it is asked, so pin the question: the owner's own ban state.
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { bannedAt: true },
    });
    expect(createdData()).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
    // Rated now, so the row is not unrated media if the block is ever lifted.
    expect(createImageIngestionRequest).toHaveBeenCalledOnce();
  });

  it('who is banned stores the image blocked even when the caller skips ingestion', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date() } as never);

    await create({ skipIngestion: true });

    expect(createdData()).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
  });

  it('who is not banned stores the image pending and sends it to scan', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null } as never);

    await create();

    expect(createdData().ingestion).toBeUndefined();
    expect(createdData().blockedFor).toBeUndefined();
    expect(createdData().nsfwLevel).toBeUndefined();
    expect(createImageIngestionRequest).toHaveBeenCalledOnce();
  });
});
