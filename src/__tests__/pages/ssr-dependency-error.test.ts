import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Model and post pages: only a CONFIRMED missing row is a 404. A database that cannot be reached must
// not tell users, crawlers and caches the page does not exist: the resolver throws a 503-marked error
// with `Cache-Control: no-store`, and `_error` answers with that status.

const h = vi.hoisted(() => ({
  getPostDetail: vi.fn(),
  getDefaultModelVersion: vi.fn(),
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (config: unknown) => config,
}));
vi.mock('~/server/services/post.service', () => ({ getPostDetail: h.getPostDetail }));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDefaultModelVersion: h.getDefaultModelVersion,
}));

type Resolver = (args: Record<string, unknown>) => Promise<unknown>;
const postPage = (await import('~/pages/posts/[postId]/[[...postSlug]]')) as unknown as {
  getServerSideProps: { resolver: Resolver };
};
const modelPage = (await import('~/pages/models/[id]/[[...slug]]')) as unknown as {
  getServerSideProps: { resolver: Resolver };
};
const errorPage = (await import('~/pages/_error')).default as unknown as {
  getInitialProps: (ctx: unknown) => Promise<{ statusCode?: number }>;
};

const unreachable = () =>
  new Prisma.PrismaClientInitializationError("Can't reach database server", 'test', 'P1001');
const notFound = () => new TRPCError({ code: 'NOT_FOUND' });

function response() {
  const headers: Record<string, string> = {};
  return {
    headers,
    res: { statusCode: 200, setHeader: (k: string, v: string) => void (headers[k] = v) },
  };
}

const visitPost = (res: unknown) =>
  postPage.getServerSideProps.resolver({
    ctx: { params: { postId: '11' }, query: {}, res },
    ssg: undefined,
    session: null,
    features: {},
  });
const visitModel = (res: unknown) =>
  modelPage.getServerSideProps.resolver({
    ctx: { params: { id: '22', slug: [] }, query: {}, res },
    ssg: undefined,
    session: null,
    features: {},
  });

beforeEach(() => {
  h.getPostDetail.mockReset();
  h.getDefaultModelVersion.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe.each([
  ['post page', visitPost, () => h.getPostDetail],
  ['model page', visitModel, () => h.getDefaultModelVersion],
])('%s', (_label, visit, lookup) => {
  it('database unreachable → throws a 503 with no-store, not notFound', async () => {
    lookup().mockRejectedValue(unreachable());
    const { res, headers } = response();
    const err = (await visit(res).then(
      (v) => ({ resolved: v }),
      (e) => e
    )) as { statusCode?: number; resolved?: unknown };
    expect(err.resolved, 'resolved instead of throwing').toBeUndefined();
    expect(err.statusCode).toBe(503);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Retry-After']).toBe('30');
  });

  it('a confirmed missing row is still notFound', async () => {
    lookup().mockRejectedValue(notFound());
    expect(await visit(response().res)).toEqual({ notFound: true });
  });

  it('a non-dependency error is rethrown as itself (500), still no-store', async () => {
    const bug = new TypeError('x is undefined');
    lookup().mockRejectedValue(bug);
    const { res, headers } = response();
    await expect(visit(res)).rejects.toBe(bug);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Retry-After']).toBeUndefined();
  });
});

describe('_error', () => {
  it('answers 503 for a dependency-unavailable throw (Next set 500 for it)', async () => {
    const res = { statusCode: 500 };
    const props = await errorPage.getInitialProps({ res, err: { statusCode: 503 } });
    expect(res.statusCode).toBe(503);
    expect(props.statusCode).toBe(503);
  });

  it('leaves any other server error at 500', async () => {
    const res = { statusCode: 500 };
    await errorPage.getInitialProps({ res, err: new Error('boom') });
    expect(res.statusCode).toBe(500);
  });
});
