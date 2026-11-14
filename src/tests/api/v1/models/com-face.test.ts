import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TRPCError } from '@trpc/server';

const { user, caller, callerContexts } = vi.hoisted(() => ({
  user: { id: 7, isModerator: false },
  caller: {
    model: { getCoverCandidates: vi.fn(), draftSfwFace: vi.fn(), upsert: vi.fn() },
  },
  callerContexts: [] as Record<string, unknown>[],
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, u: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, user),
}));
vi.mock('~/server/createContext', () => ({
  createContext: vi.fn(async () => ({ acceptableOrigin: false })),
}));
vi.mock('~/server/routers', () => ({ appRouter: {} }));
vi.mock('~/server/trpc', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCallerFactory: () => (ctx: Record<string, unknown>) => {
    callerContexts.push(ctx);
    return caller;
  },
}));

import handler from '~/pages/api/v1/models/com-face';
import {
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_MESSAGE,
} from '~/shared/utils/model-sfw-face';

const stored = {
  id: 11,
  userId: 7,
  name: 'Red Title',
  description: '<p>red</p>',
  type: 'LORA',
  uploadType: 'Created',
  status: 'Published',
  checkpointType: null as string | null,
  availability: 'Public',
  nsfw: true,
  poi: false,
  minor: false,
  sfwOnly: false,
  lockedProperties: [] as string[],
  mode: null as string | null,
  deletedAt: null,
  sfwName: null as string | null,
  sfwDescription: null as string | null,
  sfwCoverImageId: null as number | null,
  meta: null as Record<string, unknown> | null,
};

let row: typeof stored = stored;
let levelAfterSave = 0;

async function call(body: unknown, contentType = 'application/json') {
  let statusCode = 0;
  let payload: unknown;
  const res = {
    headersSent: false,
    setHeader: () => res,
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
    {
      method: 'POST',
      query: {},
      headers: { 'content-type': contentType },
      body,
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { statusCode, body: payload as Record<string, unknown> };
}

describe('POST /api/v1/models/com-face', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callerContexts.length = 0;
    row = stored;
    levelAfterSave = 2 | 8;
    // Only the selected columns come back, as from Prisma: a field the endpoint forgets to select reads undefined.
    dbMock.dbWrite.model.findUnique.mockImplementation((async (args: {
      select: Record<string, unknown>;
    }) => {
      const source: Record<string, unknown> | null = args.select.userId
        ? row
        : { nsfwLevel: levelAfterSave };
      return (
        source && Object.fromEntries(Object.entries(source).filter(([key]) => args.select[key]))
      );
    }) as never);
  });

  it("refuses another creator's model", async () => {
    row = { ...stored, userId: 8 };
    expect((await call({ action: 'draft', modelId: 11 })).statusCode).toBe(403);
    expect(caller.model.draftSfwFace).not.toHaveBeenCalled();
  });

  it('accepts a model locked as mature, for draft and save', async () => {
    row = { ...stored, lockedProperties: ['nsfw'] };
    caller.model.getCoverCandidates.mockResolvedValue([{ id: 2, url: 'b', nsfwLevel: 2 }]);
    caller.model.draftSfwFace.mockResolvedValue({ sfwName: 'Safe', sfwDescription: '<p>ok</p>' });
    const draft = await call({ action: 'draft', modelId: 11 });
    const save = await call({ action: 'save', modelId: 11, sfwName: 'Safe', sfwCoverImageId: 2 });
    expect([draft.statusCode, save.statusCode]).toEqual([200, 200]);
    expect(caller.model.draftSfwFace).toHaveBeenCalledTimes(1);
    expect(caller.model.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['minor', { minor: true }],
    ['POI', { poi: true }],
    ['SFW-only', { sfwOnly: true }],
    ['taken-down', { mode: 'TakenDown' }],
  ])('refuses a %s model, for draft and save, writing nothing', async (_, flags) => {
    row = { ...stored, ...flags };
    const draft = await call({ action: 'draft', modelId: 11 });
    const save = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    for (const res of [draft, save])
      expect([res.statusCode, res.body]).toEqual([
        409,
        { error: "This model can't get a civitai.com version.", code: 'skipped' },
      ]);
    expect(caller.model.getCoverCandidates).not.toHaveBeenCalled();
    expect(caller.model.draftSfwFace).not.toHaveBeenCalled();
    expect(caller.model.upsert).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing or deleted model', async () => {
    row = null as never;
    expect((await call({ action: 'draft', modelId: 11 })).statusCode).toBe(404);
    row = { ...stored, deletedAt: new Date() as never };
    expect((await call({ action: 'draft', modelId: 11 })).statusCode).toBe(404);
  });

  // Bulk fills a missing face only: a direct call must not overwrite one the owner wrote.
  it('skips a model that already has a .com title, writing nothing', async () => {
    row = { ...stored, sfwName: 'Owner Title' };
    const draft = await call({ action: 'draft', modelId: 11 });
    const save = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    expect([draft.statusCode, draft.body.code, save.statusCode, save.body.code]).toEqual([
      409,
      'skipped',
      409,
      'skipped',
    ]);
    expect(caller.model.draftSfwFace).not.toHaveBeenCalled();
    expect(caller.model.upsert).not.toHaveBeenCalled();
  });

  it('drafts again for a face the listing re-check removed', async () => {
    row = {
      ...stored,
      sfwName: 'Owner Title',
      meta: { comFaceRemoved: { at: '2026-11-05T00:00:00.000Z', sfwCoverImageId: 5 } },
    };
    caller.model.getCoverCandidates.mockResolvedValue([
      { id: 2, url: 'b', type: 'image', nsfwLevel: 2 },
    ]);
    caller.model.draftSfwFace.mockResolvedValue({ sfwName: 'Safe', sfwDescription: '<p>ok</p>' });
    const res = await call({ action: 'draft', modelId: 11 });
    expect(res.statusCode).toBe(200);
    expect(caller.model.draftSfwFace).toHaveBeenCalledTimes(1);
  });

  it('skips a model that has a .com cover but no .com title, writing nothing', async () => {
    row = { ...stored, sfwCoverImageId: 5 };
    const save = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    expect([save.statusCode, save.body.code]).toEqual([409, 'skipped']);
    expect(caller.model.upsert).not.toHaveBeenCalled();
  });

  it('skips a model that has only a .com description, writing nothing', async () => {
    row = { ...stored, sfwDescription: '<p>owner wrote this</p>' };
    const save = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    expect([save.statusCode, save.body.code]).toEqual([409, 'skipped']);
    expect(caller.model.upsert).not.toHaveBeenCalled();
  });

  it('skips a model not marked mature', async () => {
    row = { ...stored, nsfw: false };
    const save = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    expect([save.statusCode, save.body.code]).toEqual([409, 'skipped']);
    expect(caller.model.upsert).not.toHaveBeenCalled();
  });

  it("returns the face check's refusal as a 400, not a 500", async () => {
    caller.model.upsert.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: "The title can't be shown on civitai.com." })
    );
    const res = await call({ action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    [COM_FACE_REFUSED_MESSAGE, /in the model editor/, 422],
    [COM_FACE_CHECK_UNAVAILABLE_MESSAGE, /Couldn't check/, 400],
  ])(
    'tells the card which fields a refused draft read, apart from a check that failed',
    async (thrown, shown, status) => {
      caller.model.getCoverCandidates.mockResolvedValue([
        { id: 2, url: 'b', type: 'image', nsfwLevel: 2 },
      ]);
      caller.model.draftSfwFace.mockRejectedValueOnce(
        new TRPCError({ code: 'BAD_REQUEST', message: thrown })
      );
      const res = await call({ action: 'draft', modelId: 11 });
      expect(res.statusCode).toBe(status);
      const message = res.body.message ?? res.body.error;
      expect(message).toMatch(shown);
      expect(message).toMatch(/civitai\.red/);
      // A refusal is marked so Creator Studio offers the dispute instead of a retry.
      if (status === 422) expect(res.body.code).toBe('intent-refused');
    }
  );

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

  it('saves through the editor procedure with the stored flags, and reports the .com listing', async () => {
    row = {
      ...stored,
      uploadType: 'Trained',
      checkpointType: 'Merge',
      availability: 'Unsearchable',
      lockedProperties: ['nsfw'],
    };
    const res = await call({
      action: 'save',
      modelId: 11,
      sfwName: 'Safe',
      sfwDescription: '<p>ok</p>',
      sfwCoverImageId: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ listedOnCom: true });
    expect(caller.model.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 11,
        name: 'Red Title',
        nsfw: true,
        minor: false,
        sfwOnly: false,
        poi: false,
        type: 'LORA',
        uploadType: 'Trained',
        status: 'Published',
        checkpointType: 'Merge',
        availability: 'Unsearchable',
        sfwName: 'Safe',
        sfwCoverImageId: 2,
      })
    );
  });

  it('reports a saved face whose cover does not list the model on .com', async () => {
    levelAfterSave = 8;
    const res = await call({ action: 'save', modelId: 11, sfwName: 'Safe', sfwCoverImageId: 2 });
    expect(res.body).toEqual({ listedOnCom: false });
  });

  it('refuses a form post, which a cross-site page can send without a preflight', async () => {
    const res = await call(
      { action: 'save', modelId: 11, sfwName: 'x', sfwCoverImageId: 1 },
      'application/x-www-form-urlencoded'
    );
    expect(res.statusCode).toBe(415);
    expect(caller.model.upsert).not.toHaveBeenCalled();
    expect(callerContexts).toHaveLength(0);
  });

  it('accepts a JSON server-to-server call that has no Origin', async () => {
    caller.model.getCoverCandidates.mockResolvedValue([]);
    await call({ action: 'draft', modelId: 11 });
    expect(callerContexts[0]).toMatchObject({ acceptableOrigin: true });
  });
});
