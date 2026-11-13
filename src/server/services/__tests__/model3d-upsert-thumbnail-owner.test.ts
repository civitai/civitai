import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertModel3DSchema } from '~/server/schema/model3d.schema';
import { Prisma } from '@prisma/client';
import { setModel3DNsfwLevel, upsertModel3D } from '~/server/services/model3d.service';
import type { SessionUser } from '~/types/session';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  throwOnBlockedUserContent: vi.fn(),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, userContentOverviewCache: { refresh: vi.fn() } };
});

const { enqueueJobs } = vi.hoisted(() => ({ enqueueJobs: vi.fn() }));
vi.mock('~/server/services/job-queue.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueJobs,
}));

const db = dbMock.dbWrite;

const owner = { id: 42, username: 'maker', isModerator: false } as SessionUser;
const stranger = { id: 7, username: 'someone', isModerator: false } as SessionUser;
const moderator = { id: 1, username: 'mod', isModerator: true } as SessionUser;

const MODEL_ID = 500;
// image id -> owning user id
const images: Record<number, number> = {
  11: owner.id,
  22: stranger.id,
  33: moderator.id,
  44: owner.id,
};
const postIds: Record<number, number> = { 44: 900 };

type Input = Parameters<typeof upsertModel3D>[0]['input'];
const base = { name: 'Cube', licenseId: 1 } as Input;

beforeEach(() => {
  db.model3D.findUnique.mockReset();
  db.model3D.findUnique.mockResolvedValue({ id: MODEL_ID, userId: owner.id, lockedProperties: [] });
  db.image.findUnique.mockReset();
  db.image.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id in images
      ? { userId: images[where.id], nsfwLevel: 4, postId: postIds[where.id] ?? null }
      : null
  );
  db.model3D.update.mockReset();
  db.model3D.update.mockResolvedValue({ id: MODEL_ID });
  db.model3D.create.mockReset();
  db.model3D.create.mockResolvedValue({ id: MODEL_ID });
  enqueueJobs.mockReset();
  db.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(db));
});

const queuedRatingFor = () =>
  enqueueJobs.mock.calls.flatMap(([jobs]) => jobs).filter((j) => j.type === 'UpdateNsfwLevel');

const written = () =>
  (db.model3D.update.mock.calls[0] ?? db.model3D.create.mock.calls[0])?.[0]?.data;

describe('upsertModel3D thumbnail ownership', () => {
  it("accepts the owner's own image on create and update", async () => {
    await upsertModel3D({ input: { ...base, thumbnailImageId: 11 }, user: owner });
    expect(written().thumbnailImageId).toBe(11);

    db.model3D.create.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 11 }, user: owner });
    expect(written().thumbnailImageId).toBe(11);
  });

  it("refuses another user's image on create and update, writing nothing", async () => {
    await expect(
      upsertModel3D({ input: { ...base, thumbnailImageId: 22 }, user: owner })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 22 }, user: owner })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.model3D.create).not.toHaveBeenCalled();
    expect(db.model3D.update).not.toHaveBeenCalled();
  });

  it('refuses a missing image with the same error as a foreign one', async () => {
    const missing = upsertModel3D({ input: { ...base, thumbnailImageId: 999 }, user: owner });
    const foreign = upsertModel3D({ input: { ...base, thumbnailImageId: 22 }, user: owner });
    const [a, b] = await Promise.allSettled([missing, foreign]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    const ra = (a as PromiseRejectedResult).reason;
    const rb = (b as PromiseRejectedResult).reason;
    expect(ra.code).toBe('BAD_REQUEST');
    expect([ra.code, ra.message]).toEqual([rb.code, rb.message]);
  });

  it("lets a moderator set the model owner's image on someone else's model, and nothing else", async () => {
    await upsertModel3D({
      input: { ...base, id: MODEL_ID, thumbnailImageId: 11 },
      user: moderator,
    });
    expect(written().thumbnailImageId).toBe(11);

    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 33 }, user: moderator })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 22 }, user: moderator })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('saves without a thumbnail, and can clear one', async () => {
    await upsertModel3D({ input: { ...base, id: MODEL_ID }, user: owner });
    expect(written().thumbnailImageId).toBeUndefined();

    db.model3D.update.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: null }, user: owner });
    expect(written().thumbnailImageId).toBeNull();
    expect(db.image.findUnique).not.toHaveBeenCalled();
  });

  // Through the router's input schema, as a real request arrives.
  it('drops server-owned provenance fields from the request', async () => {
    const update = upsertModel3DSchema.parse({
      ...base,
      id: MODEL_ID,
      sourceImageId: 22,
      workflowId: 'someone-elses-workflow',
    });
    await upsertModel3D({ input: update, user: owner });
    expect(written()).not.toHaveProperty('sourceImageId');
    expect(written()).not.toHaveProperty('workflowId');

    db.model3D.update.mockClear();
    const create = upsertModel3DSchema.parse({ ...base, sourceImageId: 22, workflowId: 'wf' });
    await upsertModel3D({ input: create, user: owner });
    expect(written()).not.toHaveProperty('sourceImageId');
    expect(written()).not.toHaveProperty('workflowId');
  });

  it('queues a rating recompute when the thumbnail is set or cleared, and only then', async () => {
    const tx = new Proxy(db, {});
    db.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    await upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 11 }, user: owner });
    expect(queuedRatingFor()).toEqual([expect.objectContaining({ entityId: MODEL_ID })]);
    // Inside the write's transaction, so a failed enqueue rolls the save back instead of
    // reporting failure for a committed row.
    expect(enqueueJobs.mock.calls[0][1]).toBe(tx);

    enqueueJobs.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: null }, user: owner });
    expect(queuedRatingFor()).toHaveLength(1);

    enqueueJobs.mockClear();
    await upsertModel3D({ input: { ...base, thumbnailImageId: 11 }, user: owner });
    expect(queuedRatingFor()).toHaveLength(1);

    enqueueJobs.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID }, user: owner });
    expect(queuedRatingFor()).toHaveLength(0);
  });

  // A lock set by its owner would stop the rating job from ever touching the row.
  it("ignores lockedProperties from a non-moderator on create and update, and keeps a moderator's", async () => {
    const locked = { ...base, lockedProperties: ['nsfwLevel'] };
    await upsertModel3D({ input: locked, user: owner });
    expect(written().lockedProperties).toBeUndefined();

    db.model3D.create.mockClear();
    await upsertModel3D({ input: { ...locked, id: MODEL_ID }, user: owner });
    expect(written().lockedProperties).toBeUndefined();

    db.model3D.update.mockClear();
    await upsertModel3D({ input: locked, user: moderator });
    expect(written().lockedProperties).toEqual(['nsfwLevel']);
  });

  it('rates the model from the new thumbnail in the same write, unless the rating is locked', async () => {
    await upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 11 }, user: owner });
    expect(written().nsfwLevel).toBe(4);

    db.model3D.update.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: null }, user: owner });
    expect(written().nsfwLevel).toBe(0);

    db.model3D.update.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID }, user: owner });
    expect(written()).not.toHaveProperty('nsfwLevel');
  });

  // A moderator's rating lock pins nsfwLevel, so the thumbnail it was judged on is pinned too.
  it('refuses a thumbnail change on a model whose rating a moderator locked, unless a moderator makes it', async () => {
    db.model3D.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: owner.id,
      lockedProperties: ['nsfwLevel'],
    });
    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 11 }, user: owner })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('Contact support'),
    });
    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: null }, user: owner })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.model3D.update).not.toHaveBeenCalled();
    expect(queuedRatingFor()).toHaveLength(0);

    // Other edits still save.
    await upsertModel3D({ input: { ...base, id: MODEL_ID }, user: owner });
    expect(db.model3D.update).toHaveBeenCalledTimes(1);

    db.model3D.update.mockClear();
    await upsertModel3D({
      input: { ...base, id: MODEL_ID, thumbnailImageId: 11 },
      user: moderator,
    });
    expect(written().thumbnailImageId).toBe(11);
    expect(written()).not.toHaveProperty('nsfwLevel');
  });

  it('fails the save, not just the thumbnail, when a moderator locks the rating mid-save', async () => {
    // The lock read saw no lock; by the write, a moderator has locked the rating.
    db.model3D.update.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if ('NOT' in where) {
        throw new Prisma.PrismaClientKnownRequestError('No record found', {
          code: 'P2025',
          clientVersion: 'test',
        });
      }
      return { id: MODEL_ID };
    });

    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 11 }, user: owner })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.model3D.update.mock.calls[0][0].where).toEqual({
      id: MODEL_ID,
      NOT: { lockedProperties: { has: 'nsfwLevel' } },
    });

    // Saves that write no thumbnail are not guarded.
    db.model3D.update.mockClear();
    await upsertModel3D({ input: { ...base, id: MODEL_ID }, user: owner });
    expect(db.model3D.update.mock.calls[0][0].where).toEqual({ id: MODEL_ID });
  });

  it("keeps a moderator's rating when the owner later swaps the thumbnail", async () => {
    db.model3D.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: owner.id,
      lockedProperties: [],
    });
    await setModel3DNsfwLevel({
      id: MODEL_ID,
      nsfwLevel: 16,
      thumbnailImageId: 11,
      user: moderator,
    });
    const rated = db.model3D.update.mock.calls[0][0].data;
    expect(rated.nsfwLevel).toBe(16);

    db.model3D.update.mockClear();
    db.model3D.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: owner.id,
      lockedProperties: rated.lockedProperties,
    });
    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 11 }, user: owner })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.model3D.update).not.toHaveBeenCalled();
  });

  // The rating is locked onto whatever thumbnail the row has, so it must be the one judged.
  it("refuses a moderator's rating if the thumbnail changed after the moderator saw it", async () => {
    db.model3D.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: owner.id,
      lockedProperties: [],
    });
    db.model3D.update.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.thumbnailImageId !== 12) {
        throw new Prisma.PrismaClientKnownRequestError('No record found', {
          code: 'P2025',
          clientVersion: 'test',
        });
      }
      return { id: MODEL_ID };
    });

    // The row now holds thumbnail 12; the moderator judged 11.
    await expect(
      setModel3DNsfwLevel({ id: MODEL_ID, nsfwLevel: 1, thumbnailImageId: 11, user: moderator })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.model3D.update.mock.calls[0][0].where).toEqual({
      id: MODEL_ID,
      thumbnailImageId: 11,
    });

    await setModel3DNsfwLevel({
      id: MODEL_ID,
      nsfwLevel: 1,
      thumbnailImageId: 12,
      user: moderator,
    });
  });

  // The thumbnail rating fast paths skip posted images, so a posted thumbnail would lag a re-rate.
  it("refuses the owner's posted image, with the same error as a foreign one", async () => {
    await expect(
      upsertModel3D({ input: { ...base, id: MODEL_ID, thumbnailImageId: 44 }, user: owner })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid thumbnail image.' });
    expect(db.model3D.update).not.toHaveBeenCalled();
  });
});
