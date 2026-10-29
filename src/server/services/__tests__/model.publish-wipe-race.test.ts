import { beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { ModelMeta } from '~/server/schema/model.schema';
import { withoutRemovedWithOwner } from '~/server/utils/legal-hold';

/**
 * publishModelHandler reads the model's meta on the replica, before the publish. A content wipe, a
 * moderator or a text scan that writes the model after that read must still be seen: publishModelById
 * re-reads the row under a lock in its own transaction and builds the meta it writes from it.
 */

const { publishModelById } = await import('../model.service');

const MODEL = 1;
const OTHER_MODEL = 2;
let lockedMeta: ModelMeta | null;

// The publish's re-read sees the row only once it holds the lock on that same model.
let lockedIds: Set<unknown>;
const isModelLock = (strings: TemplateStringsArray) =>
  Array.isArray(strings) &&
  /FROM "Model"\s+WHERE id = \?\s+FOR NO KEY UPDATE/.test(strings.join('?'));

beforeEach(() => {
  vi.clearAllMocks();
  lockedMeta = {};
  lockedIds = new Set();
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (isModelLock(strings)) lockedIds.add(values[0]);
    return [];
  }) as never);
  dbMock.dbWrite.model.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) =>
    where.id === MODEL && lockedIds.has(MODEL)
      ? { status: 'Draft', availability: 'Public', meta: lockedMeta }
      : null) as never);
  dbMock.dbWrite.model.update.mockResolvedValue({
    id: MODEL,
    nsfw: false,
    userId: 5,
    status: 'Published',
    modelVersions: [],
  } as never);
});

const written = () =>
  (dbMock.dbWrite.model.update.mock.calls[0][0] as { data: { meta: unknown } }).data.meta;

const publish = (
  enforceModelRules: boolean,
  meta: Parameters<typeof publishModelById>[0]['meta'] = {}
) =>
  publishModelById({
    id: MODEL,
    meta,
    enforceModelRules,
    refuseRemovedWithOwner: enforceModelRules,
  });

it("refuses an owner's publish when the wipe hid the model after the caller's read", async () => {
  lockedMeta = { removedWithOwner: true };
  await expect(publish(true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
});

it("writes an owner's publish when the locked row carries no removal record (control)", async () => {
  lockedMeta = { showcaseCollectionId: 3 };
  await publish(true, { showcaseCollectionId: 3 });
  expect(written()).toEqual({ showcaseCollectionId: 3 });
});

it('reads the record only once it holds the lock on this model', async () => {
  lockedMeta = { removedWithOwner: true };
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (isModelLock(strings)) lockedIds.add(values[0] === MODEL ? OTHER_MODEL : values[0]);
    return [];
  }) as never);
  // A lock on another row leaves the re-read with nothing: it must not refuse on a row it never saw.
  await publish(true);
  expect(written()).toEqual({});
});

it('lets a moderator publish it, ending the removal', async () => {
  lockedMeta = { removedWithOwner: true, statusBeforeRemoval: 'Published', note: 1 } as ModelMeta;
  await publish(false, (stored) => withoutRemovedWithOwner(stored ?? {}));
  expect(written()).toEqual({ note: 1 });
});

it('keeps a server-owned key written after the caller read the meta', async () => {
  lockedMeta = {
    modelRules: { ruleIds: [1], workflowId: 'w', textHash: 'h', at: 'now' },
    minorFlagSnapshot: { at: 'now' } as ModelMeta['minorFlagSnapshot'],
    cannotPromote: true,
    trainingStudioWorkflowId: 'wf',
  };
  await publish(true, { showcaseCollectionId: 3 });
  expect(written()).toEqual({ showcaseCollectionId: 3, ...lockedMeta });
});

it("never writes a server-owned key from the caller's meta", async () => {
  lockedMeta = {};
  await publish(true, { removedWithOwner: true, cannotPromote: true, showcaseCollectionId: 3 });
  expect(written()).toEqual({ showcaseCollectionId: 3 });
});

it('refuses a publish when publishing was blocked after the caller read the meta', async () => {
  lockedMeta = { cannotPublish: true };
  await expect(publish(false)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
});

it('builds the meta from the locked row when the caller passes a builder', async () => {
  lockedMeta = { showcaseCollectionId: 3, needsReview: true };
  await publish(true, ({ needsReview: _, ...rest } = {}) => rest);
  expect(written()).toEqual({ showcaseCollectionId: 3 });
});
