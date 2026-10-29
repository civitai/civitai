import { beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ModelMeta } from '~/server/schema/model.schema';

/**
 * Three owner actions write a model's whole meta back after reading it. A content wipe, a moderator
 * or a scan that writes the meta between that read and the write must keep what it wrote: each
 * writer merges over the row it re-reads under a lock.
 */

const { requestReviewHandler, changeModelModifierHandler } = await import('../model.controller');
const { setModelShowcaseCollection } = await import('~/server/services/model.service');

const MODEL = 1;
const OWNER = 5;
// Written after the action read the model: what the write must not drop.
const WRITTEN_SINCE = {
  removedWithOwner: true,
  statusBeforeRemoval: 'Published',
  cannotPublish: true,
} satisfies ModelMeta;

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
  await requestReviewHandler({ input: { id: MODEL } });
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
