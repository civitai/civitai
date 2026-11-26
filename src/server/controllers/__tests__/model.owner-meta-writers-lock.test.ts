import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ModelMeta } from '~/server/schema/model.schema';
import type * as ModeratorEndpoint from '~/server/utils/moderator-endpoint';
import type * as CollectionService from '~/server/services/collection.service';

const saveItemInCollections = vi.fn(async (_: unknown) => 'added');
const collectionPermissions = vi.fn(async (_: unknown) => ({ write: true, manage: false }));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  saveItemInCollections: (args: unknown) => saveItemInCollections(args),
  getUserCollectionPermissionsById: (args: unknown) => collectionPermissions(args),
}));

// The moderator routes' auth is not what this file tests: their handlers are called directly.
vi.mock('~/server/utils/moderator-endpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorEndpoint>()),
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
}));

/**
 * Owner actions and the moderator take-down, bring-back and review decline write a model's whole
 * meta back after reading it. Another moderator or a scan that writes the meta
 * between that read and the write must keep what it wrote: each writer merges over the row it
 * re-reads under a lock.
 */

const { requestReviewHandler, changeModelModifierHandler, declineReviewHandler } = await import(
  '../model.controller'
);
type ModHandler = { handler: (input: { modelId: number }, ctx: unknown) => Promise<unknown> };
const takeDown = (await import('~/server/api-routes/mod/model/take-down'))
  .default as unknown as ModHandler;
const bringBack = (await import('~/server/api-routes/mod/model/bring-back'))
  .default as unknown as ModHandler;
const { setModelShowcaseCollection } = await import('~/server/services/model.service');

const MODEL = 1;
const OWNER = 5;
// Written after the action read the model: what the write must not drop.
const WRITTEN_SINCE = { cannotPublish: true, cannotPromote: true } satisfies ModelMeta;

let lockHeld: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  lockHeld = false;
  // The action's own read, before any lock: the row as it was.
  const asRead = {
    id: MODEL,
    userId: OWNER,
    status: 'UnpublishedViolation',
    mode: null,
    meta: { note: 1 },
  };
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
    db.model.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
      where.id !== MODEL
        ? null
        : db === dbMock.dbWrite && lockHeld
        ? { ...asRead, meta: { note: 1, ...WRITTEN_SINCE } }
        : asRead) as never);
    db.model.findFirst.mockResolvedValue(asRead as never);
  }
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
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: object }) => ({
    id: MODEL,
    userId: OWNER,
    ...data,
  })) as never);
});

const written = () =>
  (dbMock.dbWrite.model.update.mock.calls[0][0] as { data: { meta: unknown } }).data.meta;

const ctx = (isModerator = false) =>
  ({ user: { id: OWNER, isModerator }, track: { modelEvent: vi.fn() } } as never);

it('keeps what was written since when an owner requests a review', async () => {
  await requestReviewHandler({ input: { id: MODEL }, ctx: ctx() });
  expect(written()).toEqual({ note: 1, ...WRITTEN_SINCE, needsReview: true });
});

it('keeps what was written since when an owner archives the model', async () => {
  await changeModelModifierHandler({ input: { id: MODEL, mode: 'Archived' }, ctx: ctx() });
  expect(written()).toEqual({
    note: 1,
    ...WRITTEN_SINCE,
    archivedAt: expect.any(String),
    archivedBy: OWNER,
  });
});

it('keeps what was written since when an owner sets the showcase collection', async () => {
  await setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER });
  expect(written()).toEqual({ note: 1, ...WRITTEN_SINCE, showcaseCollectionId: 9 });
});

it('keeps what was written since when a moderator takes the model down', async () => {
  await changeModelModifierHandler({ input: { id: MODEL, mode: 'TakenDown' }, ctx: ctx(true) });
  expect(written()).toEqual({
    note: 1,
    ...WRITTEN_SINCE,
    takenDownAt: expect.any(String),
    takenDownBy: OWNER,
  });
});

it('drops the archive stamps, and keeps what was written since, when an owner unarchives', async () => {
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.model.findFirst.mockResolvedValue({ id: MODEL, mode: 'Archived' } as never);
  dbMock.dbWrite.model.findUnique.mockImplementation((async () =>
    lockHeld
      ? { meta: { note: 1, ...WRITTEN_SINCE, archivedAt: 'then', archivedBy: OWNER } }
      : null) as never);

  await changeModelModifierHandler({ input: { id: MODEL, mode: null }, ctx: ctx() });

  expect(written()).toEqual({ note: 1, ...WRITTEN_SINCE });
});

describe('setting the showcase collection', () => {
  it('adds the model to the collection it shows', async () => {
    await setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER });
    expect(saveItemInCollections).toHaveBeenCalledWith({
      input: expect.objectContaining({
        collections: [{ collectionId: 9 }],
        modelId: MODEL,
        type: 'Model',
        userId: OWNER,
      }),
    });
    expect(saveItemInCollections).toHaveBeenCalledTimes(1);
  });

  it('adds with a moderator’s permissions when a moderator sets it', async () => {
    await setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: 7, isModerator: true });
    expect(saveItemInCollections).toHaveBeenCalledWith({
      input: expect.objectContaining({ userId: 7, isModerator: true }),
    });
  });

  it('returns a refused add and leaves the showcase unset', async () => {
    saveItemInCollections.mockRejectedValueOnce(new Error('Collection type mismatch'));
    await expect(
      setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER })
    ).rejects.toThrow('Collection type mismatch');
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses the showcase when the add writes nothing', async () => {
    saveItemInCollections.mockResolvedValueOnce(null as never);
    await expect(
      setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('leaves a model already in the collection alone', async () => {
    dbMock.dbWrite.collectionItem.findFirst.mockResolvedValueOnce({ id: 1 } as never);
    await setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER });
    expect(saveItemInCollections).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ showcaseCollectionId: 9 });
  });

  it('refuses a caller with no access the same way whether or not the model is listed', async () => {
    const refusal = async (listed: boolean) => {
      dbMock.dbWrite.collectionItem.findFirst.mockResolvedValue(
        (listed ? { id: 1 } : null) as never
      );
      collectionPermissions.mockResolvedValueOnce({ write: false, manage: false });
      return setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER }).catch(
        (error: { code: string; message: string }) => ({ code: error.code, message: error.message })
      );
    };
    const notListed = await refusal(false);
    expect(notListed).toEqual({
      code: 'BAD_REQUEST',
      message: 'The model could not be added to that collection',
    });
    expect(await refusal(true)).toEqual(notListed);
    dbMock.dbWrite.collectionItem.findFirst.mockReset();
    expect(saveItemInCollections).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a collection the model is already in when the owner cannot write to it', async () => {
    dbMock.dbWrite.collectionItem.findFirst.mockResolvedValueOnce({ id: 1 } as never);
    // A review-only contributor cannot write straight in, so it cannot pick the showcase either.
    collectionPermissions.mockResolvedValueOnce({
      write: false,
      manage: false,
      writeReview: true,
    } as never);
    await expect(
      setModelShowcaseCollection({ id: MODEL, collectionId: 9, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(collectionPermissions).toHaveBeenCalledWith({
      id: 9,
      userId: OWNER,
      isModerator: undefined,
    });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('adds nothing when the showcase is cleared', async () => {
    await setModelShowcaseCollection({ id: MODEL, collectionId: null, userId: OWNER });
    expect(saveItemInCollections).not.toHaveBeenCalled();
  });
});

it('stores a cleared showcase as null', async () => {
  await setModelShowcaseCollection({ id: MODEL, collectionId: null, userId: OWNER });
  expect(written()).toEqual({ note: 1, ...WRITTEN_SINCE, showcaseCollectionId: null });
});

it('refuses an owner’s archive when a moderator took the model down after the read', async () => {
  dbMock.dbWrite.model.findUnique.mockImplementation((async () =>
    lockHeld
      ? { mode: 'TakenDown', meta: { note: 1, takenDownAt: 'then', takenDownBy: 7 } }
      : null) as never);

  await expect(
    changeModelModifierHandler({ input: { id: MODEL, mode: 'Archived' }, ctx: ctx() })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
});

it('refuses an owner’s archive of a model already taken down', async () => {
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.model.findFirst.mockResolvedValue({ id: MODEL, mode: 'TakenDown' } as never);
  await expect(
    changeModelModifierHandler({ input: { id: MODEL, mode: 'Archived' }, ctx: ctx() })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
});

describe('the moderator writers', () => {
  const actor = { actor: { id: 7 }, tracker: { modelEvent: vi.fn() } };
  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockImplementation((async () =>
      lockHeld
        ? {
            status: 'UnpublishedViolation',
            mode: null,
            meta: { note: 1, ...WRITTEN_SINCE },
          }
        : null) as never);
  });

  it('keeps what was written since when a moderator takes it down in the moderator app', async () => {
    await takeDown.handler({ modelId: MODEL }, actor);
    expect(written()).toEqual({
      note: 1,
      ...WRITTEN_SINCE,
      takenDownAt: expect.any(String),
      takenDownBy: 7,
    });
  });

  it('keeps what was written since when a moderator brings it back', async () => {
    for (const db of [dbMock.dbRead, dbMock.dbWrite])
      db.model.findFirst.mockResolvedValue({ id: MODEL, mode: 'TakenDown' } as never);
    dbMock.dbWrite.model.findUnique.mockImplementation((async () =>
      lockHeld
        ? { mode: 'TakenDown', meta: { note: 1, ...WRITTEN_SINCE, takenDownAt: 'then' } }
        : null) as never);

    await bringBack.handler({ modelId: MODEL }, actor);

    expect(written()).toEqual({ note: 1, ...WRITTEN_SINCE });
  });

  it('keeps what was written since when a moderator declines a review', async () => {
    await declineReviewHandler({ input: { id: MODEL, reason: 'no' }, ctx: ctx(true) });
    expect(written()).toEqual({
      note: 1,
      ...WRITTEN_SINCE,
      declinedReason: 'no',
      declinedAt: expect.any(String),
      needsReview: false,
    });
  });
});

describe('the locked re-checks of the moderator writers', () => {
  const actor = { actor: { id: 7 }, tracker: { modelEvent: vi.fn() } };
  const lockedRow = (row: object) =>
    dbMock.dbWrite.model.findUnique.mockImplementation((async () =>
      lockHeld ? { meta: { note: 1 }, ...row } : null) as never);

  it('refuses a take-down when another moderator took it down after the read', async () => {
    lockedRow({ mode: 'TakenDown' });
    await expect(takeDown.handler({ modelId: MODEL }, actor)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a bring-back when it was brought back after the read', async () => {
    for (const db of [dbMock.dbRead, dbMock.dbWrite])
      db.model.findFirst.mockResolvedValue({ id: MODEL, mode: 'TakenDown' } as never);
    lockedRow({ mode: null });
    await expect(bringBack.handler({ modelId: MODEL }, actor)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a review request when the model was republished after the read', async () => {
    lockedRow({ status: 'Published' });
    await expect(requestReviewHandler({ input: { id: MODEL }, ctx: ctx() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a decline when the model left review after the read', async () => {
    lockedRow({ status: 'Published' });
    await expect(
      declineReviewHandler({ input: { id: MODEL, reason: 'no' }, ctx: ctx(true) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });
});
