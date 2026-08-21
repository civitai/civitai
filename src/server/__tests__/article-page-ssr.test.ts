import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import type * as ArticleService from '~/server/services/article.service';

/**
 * `/articles/<id>` SSR: which article states reach a crawler as a 200, and which as a 404.
 *
 * `article.getById` is viewer-scoped — it resolves for the owner and moderators and throws
 * NOT_FOUND for everyone else — so the resolver's handling of that rejection is the whole
 * owner-vs-crawler distinction. Asserted here rather than through the component, because the
 * client render happens after the status code is already committed.
 *
 * This covers the resolver only. `createServerSideProps` turning `{ notFound: true }` into a Next
 * 404 is pinned in `session-props.test.ts`, since driving it for real needs a wholesale router
 * mock the mock-surface guard bans.
 */

type Resolver = (ctx: any) => Promise<any>;

// `vi.hoisted` so these exist before the hoisted page import below runs the module factory.
const captured = vi.hoisted(() => ({ resolver: undefined as Resolver | undefined }));
const isArticlePublishedMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: Resolver }) => {
    captured.resolver = resolver;
    return vi.fn();
  },
}));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  isArticlePublished: (...args: [number]) => isArticlePublishedMock(...args),
}));

// Module scope, not inside a test: transforming the page's graph (Mantine, tabler, the SCSS
// module) inside the first test's clock is what makes a file like this red on a busy box.
import '~/pages/articles/[id]/[[...slug]]';

const ARTICLE_ID = 33867;
const SLUG = 'pixel-forge-basics';

const draft = {
  id: ARTICLE_ID,
  title: 'Pixel Forge Basics',
  nsfwLevel: 1,
  publishedAt: null,
  user: { id: 42 },
};

const run = async ({
  fetchImpl,
  published = false,
  clientNav = false,
}: {
  fetchImpl?: () => Promise<unknown>;
  published?: boolean;
  clientNav?: boolean;
}) => {
  if (!captured.resolver) throw new Error('resolver was never captured');
  isArticlePublishedMock.mockResolvedValue(published);

  return captured.resolver({
    ctx: { query: { id: String(ARTICLE_ID), slug: [SLUG] } },
    isClient: clientNav,
    ssg: clientNav
      ? undefined
      : {
          article: { getById: { fetch: vi.fn(fetchImpl) } },
          hiddenPreferences: { getHidden: { prefetch: vi.fn(async () => undefined) } },
        },
  });
};

const rejectWith = (code: TRPCError['code']) => async () => {
  throw new TRPCError({ code });
};

describe('article detail SSR', () => {
  it('404s an article the viewer cannot see and nobody else can either', async () => {
    const result = await run({ fetchImpl: rejectWith('NOT_FOUND'), published: false });

    expect(result).toEqual({ notFound: true });
  });

  it('serves the article to a viewer who can see it — the owner reading their own draft', async () => {
    const result = await run({ fetchImpl: async () => draft });

    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeUndefined();
    expect(result.props).toMatchObject({ id: ARTICLE_ID });
    expect(result.suppressAds).toBe(true);
    expect(result.gating).toEqual({ contentNsfwLevel: draft.nsfwLevel });
  });

  it('keeps serving a published article that is only unreadable while it re-scans', async () => {
    const result = await run({ fetchImpl: rejectWith('NOT_FOUND'), published: true });

    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeUndefined();
    expect(result.props).toMatchObject({ id: ARTICLE_ID });
  });

  it('keeps serving the page when the fetch fails for a reason other than NOT_FOUND', async () => {
    const result = await run({ fetchImpl: rejectWith('INTERNAL_SERVER_ERROR') });

    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeUndefined();
    expect(result.props).toMatchObject({ id: ARTICLE_ID });
  });

  it('leaves client-side navigation alone — the status code is an SSR-only decision', async () => {
    const result = await run({ clientNav: true });

    expect(result.notFound).toBeUndefined();
    expect(result.props).toMatchObject({ id: ARTICLE_ID });
  });
});
