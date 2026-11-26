import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PostService from '~/server/services/post.service';
import type * as CommonService from '~/server/services/common.service';
import type * as BrowsingLevelUtils from '~/server/utils/browsing-level';
import { OUTSIDE_TRIAL, recordingSsg, SIGNED_IN, trialRequest } from '../ssr-skip-prefetch.fixture';

/**
 * `/posts/[postId]`'s `getServerSideProps` under `ssrSignedInSkipPrefetchPosts`.
 *
 * - Flag ON + signed in: `post.get` (the `<head>`, and NotFound when the viewer gets no post), the
 *   contest details (the rating the page gates on) and the hidden preferences (NotFound for a
 *   blocked creator); no image list and no image filters; the page gets `deferredSsr: true`.
 * - Flag OFF, the model page's flag, anonymous, a verified bot, a bot-cache candidate or a
 *   `/_next/data` request: the full prefetch set and the props exactly as before (no `deferredSsr`).
 * - Every 404 (bad id, missing post, private post) and the ad gating are the same in every arm.
 */

const m = vi.hoisted(() => ({
  post: null as null | Record<string, unknown>,
  hasAccess: true,
  imageFilters: 0,
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/utils/ssr-client-only-sections', () => ({
  ssrClientOnlySectionsOn: () => false,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  getPostDetail: async () => m.post,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: async ({ entityIds }: { entityIds: number[] }) =>
    entityIds.map((entityId) => ({ entityId, hasAccess: m.hasAccess })),
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelUtils>()),
  getServerImageQueryFilters: async () => {
    m.imageFilters++;
    return { excludedTagIds: [] };
  },
}));

const { getServerSideProps } = await import('~/pages/posts/[postId]/[[...postSlug]]');

const POST_ID = 6113;
/** R-rated and unpublished, so the gating and ads it declares are distinguishable from defaults. */
const PUBLIC_POST = {
  id: POST_ID,
  availability: 'Public',
  nsfwLevel: 4,
  nsfw: true,
  publishedAt: null,
};

type Viewer = 'signed-in' | 'anonymous';

async function run({
  features,
  viewer = 'signed-in',
  id = String(POST_ID),
  url = `/posts/${POST_ID}`,
  headers,
  marks,
}: {
  features: Record<string, boolean>;
  viewer?: Viewer;
  id?: string;
  url?: string;
  headers?: Record<string, string>;
  marks?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const request = trialRequest({ url, headers, marks });
  const resolver = getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  const result = await resolver({
    ssg: recordingSsg(calls),
    ctx: { params: { postId: id }, query: { postId: id }, req: request.req, res: {} },
    session: viewer === 'signed-in' ? SIGNED_IN : null,
    features,
  });
  return { result, procs: calls.sort(), cohort: request.cohort(), route: request.route() };
}

const ON = { ssrSignedInSkipPrefetchPosts: true };
const OFF = { ssrSignedInSkipPrefetchPosts: false };

const FULL = [
  'prefetch hiddenPreferences.getHidden',
  'prefetch post.get',
  'prefetch post.getContestCollectionDetails',
  'prefetchInfinite image.getInfinite',
];
const SKIP = FULL.filter((p) => p !== 'prefetchInfinite image.getInfinite');

const page = (deferredSsr: boolean) => ({
  props: {
    postId: POST_ID,
    ssrClientOnlySections: false,
    ...(deferredSsr ? { deferredSsr: true } : {}),
  },
  gating: { contentNsfwLevel: 4, nsfw: true },
  suppressAds: true,
});

beforeEach(() => {
  m.post = PUBLIC_POST;
  m.hasAccess = true;
  m.imageFilters = 0;
});

describe('post page getServerSideProps — ssrSignedInSkipPrefetchPosts', () => {
  it('ON + signed in: no image list, and the page renders its shell', async () => {
    const { result, procs, cohort, route } = await run({ features: ON });

    expect(procs).toEqual(SKIP);
    // Nor the filters the image list is queried with.
    expect(m.imageFilters).toBe(0);
    expect(result).toEqual(page(true));
    expect(cohort).toBe('skip');
    expect(route).toBe('/posts/[postId]/[[...postSlug]]');
  });

  it('OFF + signed in: the full prefetch set, and the props exactly as before', async () => {
    const { result, procs, cohort } = await run({ features: OFF });

    expect(procs).toEqual(FULL);
    expect(m.imageFilters).toBe(1);
    expect(result).toEqual(page(false));
    expect((result as { props: object }).props).not.toHaveProperty('deferredSsr');
    expect(cohort).toBe('full');
  });

  it("the model page's flag does not turn this page's trial on", async () => {
    const { result, procs, cohort } = await run({ features: { ssrSignedInSkipPrefetch: true } });

    expect(procs).toEqual(FULL);
    expect(result).toEqual(page(false));
    expect(cohort).toBe('full');
  });

  it.each([false, true])('anonymous (flag %s): the full prefetch set', async (flag) => {
    const { result, procs, cohort } = await run({
      features: { ssrSignedInSkipPrefetchPosts: flag },
      viewer: 'anonymous',
    });

    expect(procs).toEqual(FULL);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });

  it.each(OUTSIDE_TRIAL)('ON + signed in, but $name: the full prefetch set', async (outside) => {
    const { result, procs, cohort } = await run({ features: ON, ...outside });

    expect(procs).toEqual(FULL);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });

  it('ON + signed in, a private post the viewer may see: the shell, after the access check', async () => {
    m.post = { ...PUBLIC_POST, availability: 'Private' };
    const { result, procs, cohort } = await run({ features: ON });

    expect(procs).toEqual(SKIP);
    expect(result).toEqual(page(true));
    expect(cohort).toBe('skip');
  });
});

const ARMS: { name: string; features: Record<string, boolean>; viewer: Viewer }[] = [
  { name: 'ON + signed in', features: ON, viewer: 'signed-in' },
  { name: 'OFF + signed in', features: OFF, viewer: 'signed-in' },
  { name: 'ON + anonymous', features: ON, viewer: 'anonymous' },
];

// A 404 is not a render of this page, so it is never counted in the trial.
describe.each(ARMS)('post page 404 outcomes — $name', ({ features, viewer }) => {
  it('a non-numeric id is a 404, before any prefetch', async () => {
    const { result, procs, cohort } = await run({ features, viewer, id: 'abc' });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
    expect(cohort).toBeUndefined();
  });

  it('a post the viewer gets none of (deleted, or not theirs to see) is a 404', async () => {
    m.post = null;
    const { result, procs, cohort } = await run({ features, viewer });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
    expect(cohort).toBeUndefined();
  });

  it('a private post the viewer has no access to is a 404', async () => {
    m.post = { ...PUBLIC_POST, availability: 'Private' };
    m.hasAccess = false;
    const { result, procs, cohort } = await run({ features, viewer });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
    expect(cohort).toBeUndefined();
  });
});
