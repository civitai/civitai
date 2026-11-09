import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as KyselyDb from '~/server/db/kyselyDb';
import type * as Award from '~/server/events/points/award';

// The CommentV2 delete site: a moderator bulk delete removes the points of each author whose last
// comment under an Image or Article it took.

const { removeEventPoints, hatted } = vi.hoisted(() => ({
  removeEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

// The hook counts the actor's live comments left under the entity in CommentV3; `live` is that count.
const kysely = vi.hoisted(() => {
  const state = { live: 0, counted: [] as { table: string; where: unknown[][] }[] };
  const selectFrom = (table: string) => {
    const call = { table, where: [] as unknown[][] };
    state.counted.push(call);
    const query = {
      select: () => query,
      where: (...a: unknown[]) => {
        call.where.push(a);
        return query;
      },
      executeTakeFirst: async () => ({ n: String(state.live) }),
    };
    return query;
  };
  return { state, selectFrom };
});
vi.mock('~/server/db/kyselyDb', async (importOriginal) => ({
  ...(await importOriginal<typeof KyselyDb>()),
  kyselyWrite: { selectFrom: kysely.selectFrom },
}));

vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  removeEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
  isHattedEntityOnceLoaded: async (entityType: string, entityId: number) =>
    hatted.has(`${entityType}:${entityId}`),
}));

import { bulkDeleteCommentsV2 } from '~/server/services/commentsv2.service';

const db = dbMock.dbWrite;
const USER = 5;
const IMAGE_THREAD = { id: 70, rootThreadId: null, imageId: 7, articleId: null, rootThread: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  hatted.add('Image:7');
  kysely.state.live = 0;
  kysely.state.counted.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db.thread.findUnique.mockResolvedValue(IMAGE_THREAD);
  db.thread.findMany.mockResolvedValue([IMAGE_THREAD]);
});

describe('CommentV2 event points', () => {
  it('removes for each author the bulk delete deleted', async () => {
    // The DELETE returns the rows it took; an id it did not find is not among them.
    vi.mocked(db.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('').includes('DELETE FROM')
        ? [
            { userId: USER, threadId: 70 },
            { userId: 6, threadId: 70 },
          ]
        : []) as never);

    await expect(bulkDeleteCommentsV2({ ids: [1, 2, 3] })).resolves.toEqual({ deleted: 2 });
    await settle();

    expect(removeEventPoints.mock.calls.map(([[removal]]) => removal.sourceId)).toEqual([
      `CommentV2:Image:7:${USER}`,
      'CommentV2:Image:7:6',
    ]);
  });
});
