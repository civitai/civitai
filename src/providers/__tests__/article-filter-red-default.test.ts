import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ArticleSort } from '~/server/common/enums';
import {
  RED_ARTICLE_FILTER_MIGRATION_KEY,
  getInitialLocalStorageValues,
} from '~/providers/FiltersProvider';

const ARTICLES_KEY = 'article-filters';
const oldDefaults = { sort: ArticleSort.MostBookmarks, period: MetricTimeframe.Month };

const store = new Map<string, string>();
vi.stubGlobal('window', {});
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const save = (value: object) => store.set(ARTICLES_KEY, JSON.stringify(value));
const articles = (isRed: boolean) => getInitialLocalStorageValues({ isRed }).articles;

describe('articles feed default sort by domain', () => {
  beforeEach(() => store.clear());

  it('defaults to Newest on civitai.red', () => {
    expect(articles(true).sort).toBe(ArticleSort.Newest);
  });

  it('keeps Most Bookmarks elsewhere', () => {
    expect(articles(false).sort).toBe(ArticleSort.MostBookmarks);
  });

  it('moves a saved untouched default to Newest on red, once', () => {
    save({ ...oldDefaults, followed: true });
    expect(articles(true)).toMatchObject({ sort: ArticleSort.Newest, followed: true });
    expect(JSON.parse(store.get(ARTICLES_KEY) as string).sort).toBe(ArticleSort.Newest);

    // A deliberate pick of the old pair after the migration ran is kept.
    save(oldDefaults);
    expect(articles(true).sort).toBe(ArticleSort.MostBookmarks);
  });

  it.each([
    ['a chosen sort', { sort: ArticleSort.MostComments, period: MetricTimeframe.Month }],
    ['a chosen period', { sort: ArticleSort.MostBookmarks, period: MetricTimeframe.Week }],
  ])('keeps %s on red', (_label, saved) => {
    save(saved);
    expect(articles(true)).toMatchObject(saved);
  });

  it('server render uses the same per-domain default', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(articles(true).sort).toBe(ArticleSort.Newest);
      expect(articles(false).sort).toBe(ArticleSort.MostBookmarks);
    } finally {
      vi.stubGlobal('window', {});
    }
  });

  it('resets unparseable saved filters to Newest on red', () => {
    save({ sort: 'bogus' });
    expect(articles(true).sort).toBe(ArticleSort.Newest);
    expect(JSON.parse(store.get(ARTICLES_KEY) as string).sort).toBe(ArticleSort.Newest);
  });

  it('a later pick of the old pair survives when the first run had nothing to rewrite', () => {
    save({ sort: ArticleSort.MostComments, period: MetricTimeframe.Month });
    articles(true);
    save(oldDefaults);
    expect(articles(true).sort).toBe(ArticleSort.MostBookmarks);
  });

  it('never migrates off red', () => {
    save(oldDefaults);
    expect(articles(false).sort).toBe(ArticleSort.MostBookmarks);
    expect(store.get(RED_ARTICLE_FILTER_MIGRATION_KEY)).toBeUndefined();
  });
});
