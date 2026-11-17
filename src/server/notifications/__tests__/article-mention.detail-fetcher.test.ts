import { describe, expect, it, vi } from 'vitest';
import { articleDetailFetcher } from '~/server/notifications/detail-fetchers/article.detail-fetcher';

const author = { id: 7, username: 'article-author' };
const commenter = { id: 9, username: 'commenter' };

const fakeDb = () => {
  const findMany = vi.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
    where.id.in.includes(42) ? [{ id: 42, title: 'An article', user: author }] : []
  );
  return { db: { article: { findMany } } as never, findMany };
};

const notification = (type: string, details: Record<string, unknown>) => ({
  id: 1,
  type,
  details,
});

// Dispatch the way populateNotificationDetails does: a row reaches a fetcher only if its type is listed.
const run = async (rows: ReturnType<typeof notification>[], db: never) =>
  articleDetailFetcher.fetcher(
    rows.filter((n) => articleDetailFetcher.types.includes(n.type)),
    { db, showSfwFace: true }
  );

describe('article detail fetcher on mention notifications', () => {
  it('shows the article author on a mention in an article', async () => {
    const { db } = fakeDb();
    const rows = [notification('new-mention', { mentionedIn: 'article', articleId: 42 })];

    await run(rows, db);

    expect(rows[0].details.actor).toMatchObject(author);
  });

  // No comment or model mention carries an articleId today. If one gains it (say, comments on an
  // article thread), its avatar must stay the commenter's, not become the article author's.
  it('leaves comment and model mentions to their own fetchers', async () => {
    const { db, findMany } = fakeDb();
    const rows = [
      notification('new-mention', {
        mentionedIn: 'comment',
        articleId: 42,
        commentId: 3,
        actor: commenter,
      }),
      notification('new-mention', { mentionedIn: 'model', articleId: 42, modelId: 5 }),
    ];

    await run(rows, db);

    expect(rows[0].details.actor).toEqual(commenter);
    expect(rows[1].details.actor).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });
});
