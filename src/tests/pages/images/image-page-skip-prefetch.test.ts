import { describe, expect, it, vi } from 'vitest';
import { OUTSIDE_TRIAL, recordingSsg, SIGNED_IN, trialRequest } from '../ssr-skip-prefetch.fixture';

/**
 * `/images/[imageId]`'s `getServerSideProps` under `ssrSignedInSkipPrefetchImages`.
 *
 * - Flag ON + signed in: `image.get` (the main image, its NotFound and the `<head>`), the contest
 *   details (the rating the page gates on) and the hidden preferences (NotFound for a blocked
 *   creator), no `image.getGenerationData`; the page gets `deferredSsr: true`.
 * - Flag OFF, the model page's flag, anonymous, a verified bot, a bot-cache candidate or a
 *   `/_next/data` request: the full prefetch set and the props exactly as before (no `deferredSsr`).
 * - The 404 and the ad gating are the same in every arm.
 */

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/utils/ssr-client-only-sections', () => ({
  ssrClientOnlySectionsOn: () => false,
}));

const { getServerSideProps } = await import('~/pages/images/[imageId]');

const IMAGE_ID = 4207;
/** R-rated, so the gating it declares is distinguishable from a default. */
const IMAGE = { id: IMAGE_ID, nsfwLevel: 4, user: { id: 77 } };

type Viewer = 'signed-in' | 'anonymous';

async function run({
  features,
  viewer = 'signed-in',
  id = String(IMAGE_ID),
  url = `/images/${IMAGE_ID}`,
  headers,
  marks,
  image = 'found',
}: {
  features: Record<string, boolean>;
  viewer?: Viewer;
  id?: string;
  url?: string;
  headers?: Record<string, string>;
  marks?: Record<string, unknown>;
  /** `missing`: `image.get` refuses (deleted, or hidden from this viewer). */
  image?: 'found' | 'missing';
}) {
  const calls: string[] = [];
  const request = trialRequest({ url, headers, marks });
  const resolver = getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  const result = await resolver({
    ssg: recordingSsg(calls, {
      'image.get': () => {
        if (image === 'missing') throw { code: 'NOT_FOUND' };
        return IMAGE;
      },
    }),
    ctx: { params: { imageId: id }, query: { imageId: id }, req: request.req, res: {} },
    session: viewer === 'signed-in' ? SIGNED_IN : null,
    features,
  });
  return { result, procs: calls.sort(), cohort: request.cohort(), route: request.route() };
}

const ON = { ssrSignedInSkipPrefetchImages: true };
const OFF = { ssrSignedInSkipPrefetchImages: false };

const FULL_SIGNED_IN = [
  'fetch image.get',
  'fetch image.getContestCollectionDetails',
  'prefetch hiddenPreferences.getHidden',
  'prefetch image.getGenerationData',
];
// A signed-out viewer's contest details are never fetched (`~/server/page-data/image-detail`).
const FULL_ANONYMOUS = FULL_SIGNED_IN.filter(
  (p) => p !== 'fetch image.getContestCollectionDetails'
);
const SKIP = FULL_SIGNED_IN.filter((p) => p !== 'prefetch image.getGenerationData');

const page = (deferredSsr: boolean) => ({
  props: { ssrClientOnlySections: false, ...(deferredSsr ? { deferredSsr: true } : {}) },
  gating: { contentNsfwLevel: 4 },
});

describe('image page getServerSideProps — ssrSignedInSkipPrefetchImages', () => {
  it('ON + signed in: no generation data, and the page renders its shell', async () => {
    const { result, procs, cohort, route } = await run({ features: ON });

    expect(procs).toEqual(SKIP);
    expect(result).toEqual(page(true));
    expect(cohort).toBe('skip');
    expect(route).toBe('/images/[imageId]');
  });

  it('OFF + signed in: the full prefetch set, and the props exactly as before', async () => {
    const { result, procs, cohort } = await run({ features: OFF });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect((result as { props: object }).props).not.toHaveProperty('deferredSsr');
    expect(cohort).toBe('full');
  });

  it("the model page's flag does not turn this page's trial on", async () => {
    const { result, procs, cohort } = await run({ features: { ssrSignedInSkipPrefetch: true } });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect(cohort).toBe('full');
  });

  it.each([false, true])('anonymous (flag %s): the full anonymous prefetch set', async (flag) => {
    const { result, procs, cohort } = await run({
      features: { ssrSignedInSkipPrefetchImages: flag },
      viewer: 'anonymous',
    });

    expect(procs).toEqual(FULL_ANONYMOUS);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });

  it.each(OUTSIDE_TRIAL)('ON + signed in, but $name: the full prefetch set', async (outside) => {
    const { result, procs, cohort } = await run({ features: ON, ...outside });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });
});

const ARMS: { name: string; features: Record<string, boolean>; viewer: Viewer }[] = [
  { name: 'ON + signed in', features: ON, viewer: 'signed-in' },
  { name: 'OFF + signed in', features: OFF, viewer: 'signed-in' },
  { name: 'ON + anonymous', features: ON, viewer: 'anonymous' },
];

describe.each(ARMS)('image page 404 and gating — $name', ({ name, features, viewer }) => {
  it('a non-numeric id is a 404, before any prefetch, and never counted in the trial', async () => {
    const { result, procs, cohort } = await run({ features, viewer, id: 'abc' });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
    expect(cohort).toBeUndefined();
  });

  it('an image image.get refuses is still asked for, so its NotFound is decided on the server', async () => {
    const { result, procs } = await run({ features, viewer, image: 'missing' });

    expect(procs).toContain('fetch image.get');
    // No image, no rating to declare: ads follow the page default, as before.
    expect(result).toEqual({ ...page(name === 'ON + signed in'), gating: undefined });
  });
});
