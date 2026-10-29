import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The job token is not what this file tests.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  JobEndpoint: (handler: unknown) => handler,
}));

const restoreModels = (await import('~/pages/api/internal/restore-models')).default;

const MODEL = 3;
let lockedMeta: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  lockedMeta = {};
  // The candidates read before the publishes: no removal record yet.
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([
    { id: MODEL, meta: { unpublishedReason: 'duplicate' }, versionIds: [30] },
  ] as never);
  let lockHeld = false;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (
      Array.isArray(strings) &&
      /FROM "Model"\s+WHERE id = \?\s+FOR NO KEY UPDATE/.test(strings.join('?')) &&
      values[0] === MODEL
    )
      lockHeld = true;
    return [];
  }) as never);
  // Before the lock, the row as the candidates read it; under it, what a wipe may have written since.
  dbMock.dbWrite.model.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) =>
    where.id === MODEL
      ? { status: 'Unpublished', meta: lockHeld ? lockedMeta : { unpublishedReason: 'duplicate' } }
      : null) as never);
  dbMock.dbWrite.model.update.mockResolvedValue({
    id: MODEL,
    nsfw: false,
    userId: 5,
    status: 'Published',
    modelVersions: [],
  } as never);
});

const run = async () => {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  await (restoreModels as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { query: { modelIds: [MODEL] } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
};

it('leaves a model a content wipe kept after the candidates were read, and still answers 200', async () => {
  lockedMeta = { removedWithOwner: true, statusBeforeRemoval: 'Published' };

  const res = await run();

  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

it('republishes a model no wipe kept, with its meta as it is under the lock', async () => {
  lockedMeta = { unpublishedReason: 'duplicate', showcaseCollectionId: 9 };

  await run();

  expect(dbMock.dbWrite.model.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ meta: { showcaseCollectionId: 9 } }),
    })
  );
});
