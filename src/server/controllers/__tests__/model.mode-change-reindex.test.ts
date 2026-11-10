import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModeratorEndpoint from '~/server/utils/moderator-endpoint';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

vi.mock('~/server/utils/moderator-endpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorEndpoint>()),
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
}));

/**
 * A taken-down model's search document carries no images, so every change of mode queues the
 * model's document to be rebuilt; an edit that leaves the mode alone does not.
 */

const { modelsSearchIndex } = await import('~/server/search-index');
const { changeModelModifierHandler } = await import('../model.controller');
type ModHandler = { handler: (input: { modelId: number }, ctx: unknown) => Promise<unknown> };
const takeDown = (await import('~/pages/api/mod/model/take-down')).default as unknown as ModHandler;
const bringBack = (await import('~/pages/api/mod/model/bring-back'))
  .default as unknown as ModHandler;
const { setModelShowcaseCollection } = await import('~/server/services/model.service');

const MODEL = 1;
const OWNER = 5;
let mode: string | null;

const queued = vi.spyOn(modelsSearchIndex, 'queueUpdate');

beforeEach(() => {
  vi.clearAllMocks();
  queued.mockResolvedValue(undefined as never);
  mode = null;
  const row = () => ({ id: MODEL, userId: OWNER, status: 'Published', mode, meta: {} });
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
    db.model.findUnique.mockImplementation((async () => row()) as never);
    db.model.findFirst.mockImplementation((async () => row()) as never);
  }
  dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: object }) => ({
    id: MODEL,
    userId: OWNER,
    ...data,
  })) as never);
});

const ctx = (isModerator = false) =>
  ({ user: { id: OWNER, isModerator }, track: { modelEvent: vi.fn() } } as never);
const actor = { actor: { id: 7 }, tracker: { modelEvent: vi.fn() } };
const reindexed = () =>
  queued.mock.calls.some(([items]) =>
    items.some(
      (item) =>
        (item as { id: number }).id === MODEL &&
        (item as { action?: string }).action === SearchIndexUpdateQueueAction.Update
    )
  );

describe("a change of a model's mode", () => {
  it('reindexes the model when a moderator takes it down', async () => {
    await changeModelModifierHandler({ input: { id: MODEL, mode: 'TakenDown' }, ctx: ctx(true) });
    expect(reindexed()).toBe(true);
  });

  it('reindexes the model when it is taken down in the moderator app', async () => {
    await takeDown.handler({ modelId: MODEL }, actor);
    expect(reindexed()).toBe(true);
  });

  it('reindexes the model when it is brought back', async () => {
    mode = 'TakenDown';
    await bringBack.handler({ modelId: MODEL }, actor);
    expect(reindexed()).toBe(true);
  });

  it('does not reindex on an edit that leaves the mode alone', async () => {
    await setModelShowcaseCollection({ id: MODEL, collectionId: null, userId: OWNER });
    expect(reindexed()).toBe(false);
  });
});
