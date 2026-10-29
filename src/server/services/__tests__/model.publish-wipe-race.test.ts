import { beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * publishModelHandler checks a content wipe's removal record on the replica, before the publish. A
 * wipe that hides the model after that read, or inside replica lag, must still refuse an owner's
 * publish: publishModelById re-reads the record under a row lock, in the publish's own transaction.
 */

const { publishModelById } = await import('../model.service');

const MODEL = 1;
let lockedMeta: unknown;
const tx = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
    strings.join('?').includes('FOR UPDATE') ? [{ meta: lockedMeta }] : []
  ),
  $executeRaw: vi.fn(async () => 1),
  model: {
    update: vi.fn(async () => ({ id: MODEL, nsfw: false, userId: 5, modelVersions: [] })),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  lockedMeta = {};
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (
    fn: (t: typeof tx) => Promise<unknown>
  ) => fn(tx)) as never);
});

const publish = (enforceModelRules: boolean) =>
  publishModelById({ id: MODEL, meta: {}, enforceModelRules });

it("refuses an owner's publish when the wipe hid the model after the caller's read", async () => {
  lockedMeta = { removedWithOwner: true };
  await expect(publish(true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(tx.model.update).not.toHaveBeenCalled();
});

it("writes an owner's publish when the locked row carries no removal record (control)", async () => {
  await publish(true).catch(() => undefined);
  expect(tx.model.update).toHaveBeenCalled();
});

it('lets a moderator publish it, ending the removal', async () => {
  lockedMeta = { removedWithOwner: true };
  await publish(false).catch(() => undefined);
  expect(tx.model.update).toHaveBeenCalled();
});
