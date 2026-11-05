import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { user, mockUpsertModel, caller } = vi.hoisted(() => ({
  user: { id: 7, isModerator: false },
  mockUpsertModel: vi.fn(),
  caller: {
    model: { getCoverCandidates: vi.fn(), draftSfwFace: vi.fn() },
  },
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, u: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, user),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertModel: mockUpsertModel,
}));
vi.mock('~/server/createContext', () => ({ createContext: vi.fn(async () => ({})) }));
vi.mock('~/server/routers', () => ({ appRouter: {} }));
vi.mock('~/server/trpc', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCallerFactory: () => () => caller,
}));

import handler from '~/pages/api/v1/models/com-face';

const stored = {
  id: 11,
  userId: 7,
  name: 'Red Title',
  description: '<p>red</p>',
  type: 'LORA',
  uploadType: 'Created',
  status: 'Published',
  nsfw: true,
  lockedProperties: [] as string[],
  deletedAt: null,
};

async function call(body: unknown) {
  let statusCode = 0;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
  };
  await handler(
    { method: 'POST', query: {}, headers: {}, body } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { statusCode, body: payload as Record<string, unknown> };
}

describe('POST /api/v1/models/com-face', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.model.findUnique.mockResolvedValue(stored);
  });

  it("refuses another creator's model", async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({ ...stored, userId: 8 });
    expect((await call({ action: 'draft', modelId: 11 })).statusCode).toBe(403);
    expect(caller.model.draftSfwFace).not.toHaveBeenCalled();
  });

  // Decision (Justin, hq:creator_studio_show_cf07): a model a moderator locked as mature is
  // skipped, not drafted; its owner disputes the lock instead.
  it('refuses a model locked as mature, for draft and save', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({ ...stored, lockedProperties: ['nsfw'] });
    const draft = await call({ action: 'draft', modelId: 11 });
    expect(draft.statusCode).toBe(409);
    expect(draft.body.code).toBe('locked');
    const save = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    expect(save.statusCode).toBe(409);
    expect(caller.model.draftSfwFace).not.toHaveBeenCalled();
    expect(mockUpsertModel).not.toHaveBeenCalled();
  });

  it('picks the first PG/PG-13 image as the cover and drafts through the editor procedure', async () => {
    caller.model.getCoverCandidates.mockResolvedValue([
      { id: 1, url: 'a', type: 'image', nsfwLevel: 8 },
      { id: 2, url: 'b', type: 'image', nsfwLevel: 2 },
    ]);
    caller.model.draftSfwFace.mockResolvedValue({ sfwName: 'Safe', sfwDescription: '<p>ok</p>' });
    const res = await call({ action: 'draft', modelId: 11 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sfwName: 'Safe', sfwCoverImageId: 2 });
    expect(caller.model.draftSfwFace).toHaveBeenCalledWith({
      name: 'Red Title',
      description: '<p>red</p>',
      modelId: 11,
    });
  });

  it('refuses to draft a model with no safe image, without spending a draft', async () => {
    caller.model.getCoverCandidates.mockResolvedValue([{ id: 1, nsfwLevel: 8 }]);
    const res = await call({ action: 'draft', modelId: 11 });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('no-cover');
    expect(caller.model.draftSfwFace).not.toHaveBeenCalled();
  });

  it('saves only the face, passing the stored required fields back unchanged', async () => {
    const res = await call({
      action: 'save',
      modelId: 11,
      sfwName: 'Safe',
      sfwDescription: '<p>ok</p>',
      sfwCoverImageId: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpsertModel).toHaveBeenCalledWith({
      id: 11,
      userId: 7,
      name: 'Red Title',
      type: 'LORA',
      uploadType: 'Created',
      status: 'Published',
      sfwName: 'Safe',
      sfwDescription: '<p>ok</p>',
      sfwCoverImageId: 2,
    });
  });
});
