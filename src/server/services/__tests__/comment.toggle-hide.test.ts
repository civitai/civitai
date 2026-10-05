import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));

const { toggleHideComment, getCommentCountByModel } = await import('../comment.service');

const COMMENT_ID = 11;
const VIEWER_ID = 42;

function lastQuery() {
  const [[strings, ...values]] = dbMock.dbWrite.$queryRaw.mock.calls as [
    [TemplateStringsArray, ...unknown[]]
  ];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.text.replace(/\s+/g, ' ').trim(), values: sql.values };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleHideComment (legacy model comments and their replies)', () => {
  it('scopes a non-moderator to the model owner, and to the author (pre-existing, kept on purpose)', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ hidden: false, modelId: 7 }]);

    await toggleHideComment({ id: COMMENT_ID, userId: VIEWER_ID, isModerator: false });

    const { text, values } = lastQuery();
    expect(text).toContain('JOIN "Model" m ON m.id = c."modelId"');
    expect(text).toMatch(/WHERE c\.id = \$1 AND \(m\."userId" = \$2 OR c\."userId" = \$3\)\s*$/);
    expect(values).toEqual([COMMENT_ID, VIEWER_ID, VIEWER_ID]);
    expect(dbMock.dbWrite.comment.updateMany).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { hidden: true },
    });
  });

  it('refuses when the scoped lookup finds no row, and writes nothing', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      toggleHideComment({ id: COMMENT_ID, userId: VIEWER_ID, isModerator: false })
    ).rejects.toThrow(/permission to hide this comment/);
    expect(dbMock.dbWrite.comment.updateMany).not.toHaveBeenCalled();
  });

  it('lets a moderator through with no ownership clause', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ hidden: true, modelId: 7 }]);

    await toggleHideComment({ id: COMMENT_ID, userId: VIEWER_ID, isModerator: true });

    const { text, values } = lastQuery();
    expect(text).toMatch(/WHERE c\.id = \$1\s*$/);
    expect(values).toEqual([COMMENT_ID]);
    expect(dbMock.dbWrite.comment.updateMany).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { hidden: false },
    });
  });
});

describe('getCommentCountByModel', () => {
  // A hidden REPLY renders in place in its thread. It is not in the model page's
  // "See N hidden comments" modal, which lists top-level comments only, so counting it
  // there would advertise a comment the modal cannot show.
  it('counts top-level comments only', async () => {
    await getCommentCountByModel({ modelId: 7, hidden: true });

    expect(dbMock.dbRead.comment.count).toHaveBeenCalledWith({
      where: { modelId: 7, hidden: true, parentId: null },
    });
  });
});
