import { describe, expect, it, vi } from 'vitest';

/**
 * `/articles/<id>` SSR: which article states reach a crawler as a 200.
 *
 * `article.getById` is viewer-scoped — it resolves for the owner and moderators and throws
 * NOT_FOUND for everyone else — so the resolver's handling of that rejection is the whole
 * owner-vs-crawler distinction. Asserted here rather than through the component, because the
 * client render happens after the status code is already committed.
 */

type Resolver = (ctx: any) => Promise<any>;

let capturedResolver: Resolver | undefined;

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: Resolver }) => {
    capturedResolver = resolver;
    return vi.fn();
  },
}));

const ARTICLE_ID = 33867;
const SLUG = 'pixel-forge-basics';

const article = {
  id: ARTICLE_ID,
  title: 'Pixel Forge Basics',
  nsfwLevel: 1,
  publishedAt: null,
  user: { id: 42 },
};

const run = async (fetchImpl: () => Promise<unknown>) => {
  if (!capturedResolver) await import('~/pages/articles/[id]/[[...slug]]');
  if (!capturedResolver) throw new Error('resolver was never captured');

  return capturedResolver({
    ctx: { query: { id: String(ARTICLE_ID), slug: [SLUG] } },
    isClient: false,
    ssg: {
      article: { getById: { fetch: vi.fn(fetchImpl) } },
      hiddenPreferences: { getHidden: { prefetch: vi.fn(async () => undefined) } },
    },
  });
};

const trpcError = (code: string) => Object.assign(new Error(code), { code, name: 'TRPCError' });

describe('article detail SSR', () => {
  it('404s an article the viewer cannot see, instead of a 200 with no content', async () => {
    const result = await run(async () => {
      throw trpcError('NOT_FOUND');
    });

    expect(result).toEqual({ notFound: true });
  });

  it('serves the article to a viewer who can see it — the owner reading their own draft', async () => {
    const result = await run(async () => article);

    expect(result.notFound).toBeUndefined();
    expect(result.redirect).toBeUndefined();
    expect(result.props).toMatchObject({ id: ARTICLE_ID });
  });

  it('keeps serving the page when the fetch fails for a reason other than NOT_FOUND', async () => {
    const result = await run(async () => {
      throw trpcError('INTERNAL_SERVER_ERROR');
    });

    expect(result.notFound).toBeUndefined();
    expect(result.props).toMatchObject({ id: ARTICLE_ID });
  });
});
