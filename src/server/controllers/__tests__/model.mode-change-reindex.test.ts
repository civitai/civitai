import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModeratorEndpoint from '~/server/utils/moderator-endpoint';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

vi.mock('~/server/utils/moderator-endpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorEndpoint>()),
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
}));

/**
 * A taken-down model has no search document, and the collection covers drawn from its images skip
 * them. Entering TakenDown deletes the model's document and queues its collections; leaving it
 * rewrites both; another change of mode rewrites the model's document only, and an edit that leaves
 * the mode alone queues neither.
 */

const { modelsSearchIndex, collectionsSearchIndex, articlesSearchIndex } = await import(
  '~/server/search-index'
);
const { changeModelModifierHandler } = await import('../model.controller');
type ModHandler = { handler: (input: { modelId: number }, ctx: unknown) => Promise<unknown> };
const takeDown = (await import('~/pages/api/mod/model/take-down')).default as unknown as ModHandler;
const bringBack = (await import('~/pages/api/mod/model/bring-back'))
  .default as unknown as ModHandler;
const { setModelShowcaseCollection, updateModelById } = await import(
  '~/server/services/model.service'
);

const MODEL = 1;
const OWNER = 5;
const COLLECTION = 9;
const ARTICLE = 11;
let mode: string | null;

const queued = vi.spyOn(modelsSearchIndex, 'queueUpdate');
const collectionsQueued = vi.spyOn(collectionsSearchIndex, 'queueUpdate');
const articlesQueued = vi.spyOn(articlesSearchIndex, 'queueUpdate');

beforeEach(() => {
  vi.clearAllMocks();
  queued.mockResolvedValue(undefined as never);
  collectionsQueued.mockResolvedValue(undefined as never);
  articlesQueued.mockResolvedValue(undefined as never);
  mode = null;
  const row = () => ({ id: MODEL, userId: OWNER, status: 'Published', mode, meta: {} });
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
    db.model.findUnique.mockImplementation((async () => row()) as never);
    db.model.findFirst.mockImplementation((async () => row()) as never);
  }
  // The collections showing the model's images, by item or cover; nothing else is read raw here.
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pg_class')) return [{ present: true }];
      if (sql.includes('"CollectionItem"')) return [{ collectionId: COLLECTION }];
      // The articles whose cover or banner is one of the model's images.
      if (sql.includes('FROM "Article" a WHERE a."coverId"')) return [{ id: ARTICLE }];
      return [];
    }) as never);
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: object }) => ({
    id: MODEL,
    userId: OWNER,
    ...data,
  })) as never);
});

const ctx = (isModerator = false) =>
  ({ user: { id: OWNER, isModerator }, track: { modelEvent: vi.fn() } } as never);
const actor = { actor: { id: 7 }, tracker: { modelEvent: vi.fn() } };
const queuedAs = (action: SearchIndexUpdateQueueAction) =>
  queued.mock.calls.some(([items]) =>
    items.some(
      (item) =>
        (item as { id: number }).id === MODEL && (item as { action?: string }).action === action
    )
  );
const reindexed = () => queuedAs(SearchIndexUpdateQueueAction.Update);
// A taken-down model is not index-eligible, so its document is deleted rather than rewritten.
const removedFromSearch = () =>
  queuedAs(SearchIndexUpdateQueueAction.Delete) && !queuedAs(SearchIndexUpdateQueueAction.Update);

const collectionRebuilt = () =>
  collectionsQueued.mock.calls.some(([items]) =>
    items.some(
      (item) =>
        (item as { id: number }).id === COLLECTION &&
        (item as { action?: string }).action === SearchIndexUpdateQueueAction.Update
    )
  );

const articleRebuilt = () =>
  articlesQueued.mock.calls.some(([items]) =>
    items.some(
      (item) =>
        (item as { id: number }).id === ARTICLE &&
        (item as { action?: string }).action === SearchIndexUpdateQueueAction.Update
    )
  );

// The collection rebuild runs after the response; let it settle before reading what it queued.
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a change of a model's mode", () => {
  it('removes the model from search when a moderator takes it down', async () => {
    await changeModelModifierHandler({ input: { id: MODEL, mode: 'TakenDown' }, ctx: ctx(true) });
    expect(removedFromSearch()).toBe(true);
    await settled();
    expect(collectionRebuilt()).toBe(true);
  });

  it('removes the model from search when it is taken down in the moderator app', async () => {
    await takeDown.handler({ modelId: MODEL }, actor);
    expect(removedFromSearch()).toBe(true);
    await settled();
    expect(collectionRebuilt()).toBe(true);
  });

  it('reindexes the model when it is brought back', async () => {
    mode = 'TakenDown';
    await bringBack.handler({ modelId: MODEL }, actor);
    expect(reindexed()).toBe(true);
    expect(queuedAs(SearchIndexUpdateQueueAction.Delete)).toBe(false);
    await settled();
    expect(collectionRebuilt()).toBe(true);
  });

  it.each([
    ['takes it down', null, 'TakenDown', true],
    ['brings it back', 'TakenDown', null, true],
    ['archives it', null, 'Archived', false],
  ] as const)(
    '🔴 when a moderator %s, rebuilds the articles its images cover only into or out of TakenDown',
    async (_, from, to, rebuilt) => {
      mode = from;
      await changeModelModifierHandler({ input: { id: MODEL, mode: to } as never, ctx: ctx(true) });
      await settled();
      expect(articleRebuilt()).toBe(rebuilt);
    }
  );

  it('does not reindex on an edit that leaves the mode alone', async () => {
    await setModelShowcaseCollection({ id: MODEL, collectionId: null, userId: OWNER });
    await settled();
    expect(reindexed()).toBe(false);
    expect(collectionRebuilt()).toBe(false);
  });

  it.each([
    ['archives it', null, 'Archived'],
    ['unarchives it', 'Archived', null],
  ])('reindexes the model but not its collections when its owner %s', async (_, from, to) => {
    mode = from;
    await changeModelModifierHandler({ input: { id: MODEL, mode: to } as never, ctx: ctx() });
    await settled();
    expect(reindexed()).toBe(true);
    // Archived stays searchable.
    expect(queuedAs(SearchIndexUpdateQueueAction.Delete)).toBe(false);
    expect(collectionRebuilt()).toBe(false);
  });

  // Prisma's `{ set }` form says the same as a bare value.
  it.each([
    ['takes it down', 'TakenDown', true, true],
    ['archives it', 'Archived', false, false],
  ])('reads the set form when a locked write %s', async (_, to, rebuilt, removed) => {
    await updateModelById({
      id: MODEL,
      data: { mode: { set: to as never } },
      meta: (stored) => stored ?? {},
    });
    await settled();
    expect(removed ? removedFromSearch() : reindexed()).toBe(true);
    if (!removed) expect(queuedAs(SearchIndexUpdateQueueAction.Delete)).toBe(false);
    expect(collectionRebuilt()).toBe(rebuilt);
  });

  it('rebuilds the collections on an unlocked write, which reads no prior mode', async () => {
    // The stored mode is null and the write archives it, so only the unread prior can rebuild.
    await updateModelById({ id: MODEL, data: { mode: { set: 'Archived' } } });
    await settled();
    expect(collectionRebuilt()).toBe(true);
  });
});
