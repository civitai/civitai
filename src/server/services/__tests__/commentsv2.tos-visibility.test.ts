import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserService from '~/server/services/user.service';
import type * as BlocklistService from '~/server/services/blocklist.service';

/**
 * A CommentV2 flagged as a ToS violation must not be readable by anyone but a moderator. Until this,
 * no v2 read filtered the flag — the thread query filters `hidden`, which is the author's own fold and
 * still one click away behind the "See N hidden comments" modal. A phishing comment a moderator had
 * removed stayed on the image, article or post.
 */

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/message-pattern.service', () => ({
  reportBlockedMessagePattern: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

const { getComment, getCommentsInfinite, getCommentsThreadDetails2 } = await import(
  '../commentsv2.service'
);

const threadFindUnique = dbMock.dbRead.thread.findUnique;
const pinnedFindMany = dbMock.dbRead.commentV2.findMany;
const commentCount = dbMock.dbRead.commentV2.count;
const queryRaw = dbMock.dbRead.$queryRaw;

/**
 * The paginated read is raw SQL. The conditional predicate is interpolated as a nested `Prisma.sql`,
 * which arrives as a VALUE rather than in the template's own strings — reading only `strings` sees
 * the query with every conditional clause missing, and an assertion on it passes either way.
 */
const emittedSql = () => {
  const [strings, ...values] = queryRaw.mock.calls.at(-1) as unknown as [
    TemplateStringsArray,
    ...unknown[]
  ];
  const fragments = values
    .map((v) =>
      v && typeof v === 'object' && 'strings' in v
        ? Array.from((v as { strings: string[] }).strings).join(' ')
        : ''
    )
    .join(' ');
  return `${Array.from(strings).join(' ')} ${fragments}`;
};

const list = (isModerator: boolean, extra: Record<string, unknown> = {}) =>
  getCommentsInfinite({
    entityId: 1,
    entityType: 'image',
    isModerator,
    ...extra,
  } as Parameters<typeof getCommentsInfinite>[0]);

/** Every `commentV2` where-clause the call reached, across findMany/findFirst/count/groupBy. */
const whereClauses = () =>
  [
    dbMock.dbRead.commentV2.findMany,
    dbMock.dbRead.commentV2.findFirst,
    dbMock.dbRead.commentV2.groupBy,
  ].flatMap((fn) => fn.mock.calls.map(([args]) => (args as { where?: unknown })?.where));

beforeEach(() => {
  vi.clearAllMocks();
  threadFindUnique.mockResolvedValue({ id: 10, locked: false });
  pinnedFindMany.mockResolvedValue([]);
  commentCount.mockResolvedValue(0);
  queryRaw.mockResolvedValue([]);
});

describe('CommentV2 reads and the ToS flag', () => {
  it('hides ToS-flagged comments from an ordinary viewer, in the page AND the pinned block', async () => {
    await list(false);

    expect(emittedSql()).toContain('"tosViolation" = false');
    expect(pinnedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tosViolation: false }) })
    );
  });

  it('shows them to a moderator — the queue has to be able to read what it removed', async () => {
    await list(true);

    // The column is in the SELECT list either way — it is the PREDICATE that must be absent.
    // Positive control: proves `emittedSql` is reading the query at all, so the negative below
    // cannot pass on a helper that silently returns nothing.
    expect(emittedSql()).toContain('c.hidden =');
    expect(emittedSql()).not.toContain('"tosViolation" = false');
    expect(pinnedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tosViolation: undefined }) })
    );
  });

  it('leaves them out of the "N hidden comments" count an ordinary viewer is offered', async () => {
    await getCommentsThreadDetails2({ entityId: 1, entityType: 'image' });

    expect(commentCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tosViolation: false }) })
    );
  });

  it('filters replies and their hidden-count too — a spam comment is usually a reply', async () => {
    // Two raw reads in order: the page of comments, then the reply-thread rows hanging off them.
    // getReplyThreads only runs when a depth is asked for.
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 1, threadId: 10, reactionCount: 0 }])
      .mockResolvedValueOnce([{ id: 11, commentId: 1, locked: false, commentCount: 1, depth: 1 }]);
    await list(false, { repliesDepth: 1 });

    const wheres = whereClauses();
    expect(wheres.length).toBeGreaterThan(1);
    for (const where of wheres) expect(where).toMatchObject({ tosViolation: false });
  });

  it('filters the deep-linked target comment — the notification path fetches it on its own', async () => {
    await list(false, { targetCommentId: 77 });

    expect(dbMock.dbRead.commentV2.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 77, tosViolation: false }),
      })
    );
  });

  it('shows a moderator the deep-linked target as well', async () => {
    await list(true, { targetCommentId: 77 });

    expect(dbMock.dbRead.commentV2.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 77, tosViolation: undefined }),
      })
    );
  });

  it('filters the single-comment read, which is a public procedure by id', async () => {
    dbMock.dbRead.commentV2.findFirst.mockResolvedValue({ id: 5 });
    await getComment({ id: 5 });

    expect(dbMock.dbRead.commentV2.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, tosViolation: false } })
    );
  });
});
