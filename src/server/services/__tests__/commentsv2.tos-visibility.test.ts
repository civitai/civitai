import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserService from '~/server/services/user.service';
import type * as BlocklistService from '~/server/services/blocklist.service';

/**
 * A CommentV2 flagged as a ToS violation must not be readable by anyone but a moderator. Until this,
 * no v2 read filtered the flag — `hidden` is the content owner's placeholder, which any viewer can
 * reveal. A phishing comment a moderator had removed stayed on the image, article or post.
 */

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

const { getComment, getCommentCount, getCommentsInfinite } = await import('../commentsv2.service');

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
    expect(emittedSql()).toContain('c."threadId" =');
    expect(emittedSql()).not.toContain('"tosViolation" = false');
    expect(pinnedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tosViolation: undefined }) })
    );
  });

  it('filters replies too — a spam comment is usually a reply', async () => {
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

/**
 * Filtering the comment out of the page is only half of removing it. `Thread.commentCount` is
 * maintained by an INSERT/DELETE trigger, so the flag never decrements it — and that number is
 * what renders "show N replies". Reading it leaves an affordance pointing at a comment the viewer
 * will never be shown.
 */
describe('CommentV2 counts and the ToS flag', () => {
  it('counts what the viewer can be shown, not the thread counter', async () => {
    commentCount.mockResolvedValue(3);

    await expect(getCommentCount({ entityId: 1, entityType: 'image' })).resolves.toBe(3);
    expect(commentCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tosViolation: false }) })
    );
  });

  it('counts everything for a moderator', async () => {
    await getCommentCount({ entityId: 1, entityType: 'image', isModerator: true });

    expect(commentCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tosViolation: undefined }) })
    );
  });

  // The thread is reached through the relation on purpose. Resolving it first is the obvious
  // refactor and costs a second round trip on a query the comment list fires per comment.
  it('reaches the thread through the relation, in a single query', async () => {
    await getCommentCount({ entityId: 1, entityType: 'image' });

    expect(threadFindUnique).not.toHaveBeenCalled();
    expect(commentCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ thread: { imageId: 1 } }) })
    );
  });

  it('seeds each reply thread from a filtered count rather than the thread counter', async () => {
    // The CTE row carries `commentCount: 9`; a reply count the client can trust cannot come from it.
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 1, threadId: 10, reactionCount: 0 }])
      .mockResolvedValueOnce([{ id: 11, commentId: 1, locked: false, commentCount: 9, depth: 1 }]);
    dbMock.dbRead.commentV2.groupBy.mockResolvedValue([]);

    const result = await list(false, { repliesDepth: 1 });

    expect(result?.replyThreads).toHaveLength(1);
    expect(result?.replyThreads[0].commentCount).toBe(0);
  });
});

/**
 * A comment the content owner hid stays in the thread as a placeholder, so its replies stay with it.
 * Filtering it out of the read is what used to take the whole conversation under it off the page.
 */
describe('CommentV2 reads and the hidden flag', () => {
  it('returns hidden comments inline in the page, the pinned block, the target and the replies', async () => {
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 1, threadId: 10, reactionCount: 0 }])
      .mockResolvedValueOnce([{ id: 11, commentId: 1, locked: false, commentCount: 1, depth: 1 }]);
    await list(false, { targetCommentId: 77, repliesDepth: 1 });

    const pageSql = renderedSql(0);
    expect(pageSql).toContain('c."threadId" =');
    expect(pageSql).toContain('c.hidden,');
    expect(pageSql).not.toMatch(/c\.hidden\s*=/);
    const wheres = whereClauses().filter(Boolean) as Record<string, unknown>[];
    expect(wheres.length).toBeGreaterThanOrEqual(3);
    for (const where of wheres) expect(where.hidden).toBeUndefined();
  });
});

/**
 * The Nth raw query as Postgres would receive it: template text with each value spliced in, so a
 * predicate reads the same whether it is written inline or arrives as a nested `Prisma.sql`.
 */
function renderedSql(call: number) {
  const [strings, ...values] = queryRaw.mock.calls[call] as unknown as [
    TemplateStringsArray,
    ...unknown[]
  ];
  const render = (v: unknown): string =>
    v && typeof v === 'object' && 'strings' in v
      ? Array.from((v as { strings: string[] }).strings).join('')
      : typeof v === 'boolean' || typeof v === 'number'
      ? String(v)
      : '';
  return Array.from(strings).reduce(
    (sql, str, i) => sql + str + (i < values.length ? render(values[i]) : ''),
    ''
  );
}
