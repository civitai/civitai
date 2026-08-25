import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArticleService from '~/server/services/article.service';

// The real registry, unmocked — this is what would miss a `save` swapped from
// `applyArticleContentChange` to `upsertArticle`. Only the two article-service exports
// the adapter calls are overridden; everything else is the real module.
const applyArticleContentChange = vi.fn();
const upsertArticle = vi.fn();

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  applyArticleContentChange,
  upsertArticle,
}));

const { getBlurbFanoutAdapter } = await import('~/server/services/blurb-fanout.adapters');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBlurbFanoutAdapter', () => {
  it('resolves an adapter for Article', () => {
    expect(getBlurbFanoutAdapter('Article')).toBeDefined();
  });

  it('resolves undefined for an unregistered entity type', () => {
    expect(getBlurbFanoutAdapter('Model')).toBeUndefined();
  });
});

describe('Article adapter — save', () => {
  it('calls applyArticleContentChange, never upsertArticle', async () => {
    const adapter = getBlurbFanoutAdapter('Article')!;
    await adapter.save({ entityId: 5, userId: 9, html: '<p>hi</p>' });

    expect(applyArticleContentChange).toHaveBeenCalledWith({
      id: 5,
      userId: 9,
      content: '<p>hi</p>',
    });
    expect(upsertArticle).not.toHaveBeenCalled();
  });
});

describe('Article adapter — load', () => {
  it('returns the owner and html from the article row', async () => {
    dbMock.dbRead.article.findUnique.mockResolvedValue({ userId: 9, content: '<p>hi</p>' });

    const adapter = getBlurbFanoutAdapter('Article')!;
    await expect(adapter.load(5)).resolves.toEqual({ userId: 9, html: '<p>hi</p>' });
  });

  it('returns null when the article no longer exists', async () => {
    dbMock.dbRead.article.findUnique.mockResolvedValue(null);

    const adapter = getBlurbFanoutAdapter('Article')!;
    await expect(adapter.load(5)).resolves.toBeNull();
  });

  it('selects only userId and content', async () => {
    dbMock.dbRead.article.findUnique.mockResolvedValue({ userId: 9, content: '<p>hi</p>' });

    const adapter = getBlurbFanoutAdapter('Article')!;
    await adapter.load(5);

    const [args] = dbMock.dbRead.article.findUnique.mock.calls[0];
    expect(args.select).toEqual({ userId: true, content: true });
  });
});
