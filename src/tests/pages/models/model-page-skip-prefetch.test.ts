import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as CommonService from '~/server/services/common.service';
import type * as BrowsingLevelUtils from '~/server/utils/browsing-level';
import {
  SSR_PREFETCH_COHORT_REQ_KEY,
  SSR_PREFETCH_ROUTE_REQ_KEY,
} from '~/shared/constants/ssr-prefetch-cohort.constants';
import { BOT_CACHE_REQ_KEY } from '~/shared/constants/bot-cache.constants';
import * as F from './model-page-fixture';

/**
 * The model page's `getServerSideProps` under `ssrSignedInSkipPrefetch`.
 *
 * `createServerSideProps` is replaced by one that hands back the page's own resolver, which is then
 * driven with a recording `ssg` helper, as in `model-page-defer-prefetch.test.ts` — so every
 * assertion is over exactly the calls the resolver makes and exactly what it returns.
 *
 * - Flag ON + signed in: only `model.getById` (the data the 404, slug redirect, ad gating and
 *   `<head>` need) and `hiddenPreferences.getHidden` (a blocked creator's page is NotFound on the
 *   server); the page gets `deferredSsr: true`.
 * - Flag OFF, or anonymous, a verified bot, a bot-cache candidate or a `/_next/data` request: the
 *   full prefetch set, `deferredSsr: false`.
 * - Every 404 and redirect outcome is the same literal result in every arm.
 */

const m = vi.hoisted(() => ({
  version: null as null | Record<string, unknown>,
  hasAccess: true,
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getDefaultModelVersion: async () => m.version,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: async ({ entityIds }: { entityIds: number[] }) =>
    entityIds.map((entityId) => ({ entityId, hasAccess: m.hasAccess })),
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelUtils>()),
  getServerImageQueryFilters: async () => ({ excludedTagIds: [] }),
}));

const { getServerSideProps } = await import('~/pages/models/[id]/[[...slug]]');

const PUBLIC_VERSION = {
  id: F.VERSION_IDS[0],
  status: 'Published',
  availability: 'Public',
  trainingStatus: null,
  model: { id: F.MODEL_ID, userId: F.CREATOR_ID, availability: 'Public' },
};

const SLUG = 'lantern-glow-portrait-lora';
const SIGNED_IN = { user: { id: 5, username: 'lantern-viewer', isModerator: false } };

type Call = { proc: string; method: string; input: unknown };
type GetById = 'model' | 'not-found';

/** An `ssg` helper that records every `<router>.<procedure>.<method>(input)` call. */
function recordingSsg(calls: Call[], getById: GetById) {
  return new Proxy(
    {},
    {
      get: (_t, router: string) =>
        new Proxy(
          {},
          {
            get: (_t2, proc: string) => ({
              fetch: async (input: unknown) => {
                calls.push({ proc: `${router}.${proc}`, method: 'fetch', input });
                if (router === 'model' && proc === 'getById') {
                  if (getById === 'not-found') throw { code: 'NOT_FOUND' };
                  return F.MODEL;
                }
                return null;
              },
              prefetch: async (input: unknown) => {
                calls.push({ proc: `${router}.${proc}`, method: 'prefetch', input });
              },
              prefetchInfinite: async (input: unknown) => {
                calls.push({ proc: `${router}.${proc}`, method: 'prefetchInfinite', input });
              },
            }),
          }
        ),
    }
  );
}

type Viewer = 'signed-in' | 'anonymous';

async function run({
  flag,
  viewer = 'signed-in',
  slug = [SLUG],
  query = {},
  headers = {},
  reqMarks = {},
  url = `/models/${F.MODEL_ID}/${SLUG}`,
  getById = 'model',
  id = String(F.MODEL_ID),
}: {
  flag: boolean;
  viewer?: Viewer;
  /** `null`: the bare-id URL, with no slug segment. */
  slug?: string[] | null;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Properties `_app` sets on the request before getServerSideProps runs. */
  reqMarks?: Record<string, unknown>;
  url?: string;
  getById?: GetById;
  id?: string;
}) {
  const calls: Call[] = [];
  const req: Record<string, unknown> = { url, headers, ...reqMarks };
  const resolver = getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  const result = await resolver({
    ssg: recordingSsg(calls, getById),
    ctx: {
      params: { id, slug: slug ?? undefined },
      query: { id, ...(slug ? { slug } : {}), ...query },
      req,
      res: {},
    },
    session: viewer === 'signed-in' ? SIGNED_IN : null,
    features: { ssrSignedInSkipPrefetch: flag },
  });
  return {
    result,
    procs: calls.map((c) => `${c.method} ${c.proc}`).sort(),
    cohort: req[SSR_PREFETCH_COHORT_REQ_KEY],
    route: req[SSR_PREFETCH_ROUTE_REQ_KEY],
  };
}

const FULL_SIGNED_IN = [
  'fetch model.getById',
  'prefetch blocks.listForModel',
  'prefetch common.getEntityAccess',
  'prefetch hiddenPreferences.getHidden',
  'prefetch model.getCollectionShowcase',
  'prefetch resourceReview.getUserResourceReview',
  'prefetch user.getCreator',
  'prefetch user.getEngagedModelVersions',
  'prefetchInfinite image.getInfinite',
];
// The anonymous set has no per-user queries.
const FULL_ANONYMOUS = FULL_SIGNED_IN.filter(
  (p) =>
    p !== 'prefetch resourceReview.getUserResourceReview' &&
    p !== 'prefetch user.getEngagedModelVersions'
);

const page = (deferredSsr: boolean) => ({
  props: { id: F.MODEL_ID, initialMobile: false, deferredSsr },
  gating: { contentNsfwLevel: 1, nsfw: false },
  suppressAds: false,
});

beforeEach(() => {
  m.version = PUBLIC_VERSION;
  m.hasAccess = true;
});

describe('model page getServerSideProps — ssrSignedInSkipPrefetch', () => {
  it('ON + signed in: only model.getById and the hidden preferences, and the page renders its shell', async () => {
    const { result, procs, cohort, route } = await run({ flag: true });

    expect(procs).toEqual(['fetch model.getById', 'prefetch hiddenPreferences.getHidden']);
    expect(result).toEqual(page(true));
    expect(cohort).toBe('skip');
    expect(route).toBe('/models/[id]/[[...slug]]');
  });

  it('OFF + signed in: the full prefetch set, unchanged', async () => {
    const { result, procs, cohort } = await run({ flag: false });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect(cohort).toBe('full');
  });

  it.each([false, true])('anonymous (flag %s): the full anonymous prefetch set', async (flag) => {
    const { result, procs, cohort } = await run({ flag, viewer: 'anonymous' });

    expect(procs).toEqual(FULL_ANONYMOUS);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });

  it('ON + signed in, but a verified bot: the full prefetch set', async () => {
    const { result, procs, cohort } = await run({
      flag: true,
      headers: { 'x-civitai-verified-bot': 'googlebot' },
    });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });

  it('ON + signed in, but a bot-cache candidate: the full prefetch set', async () => {
    const { result, procs, cohort } = await run({
      flag: true,
      reqMarks: { [BOT_CACHE_REQ_KEY]: 'models' },
    });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });

  it('ON + signed in, but a /_next/data request: never in the trial', async () => {
    const { result, procs, cohort } = await run({
      flag: true,
      url: `/_next/data/build-id/models/${F.MODEL_ID}/${SLUG}.json`,
    });

    expect(procs).toEqual(FULL_SIGNED_IN);
    expect(result).toEqual(page(false));
    expect(cohort).toBeUndefined();
  });
});

// Every arm the trial can put a request in, including the ones outside it.
const ARMS: { name: string; flag: boolean; viewer: Viewer }[] = [
  { name: 'ON + signed in', flag: true, viewer: 'signed-in' },
  { name: 'OFF + signed in', flag: false, viewer: 'signed-in' },
  { name: 'ON + anonymous', flag: true, viewer: 'anonymous' },
];

describe.each(ARMS)('model page 404 and redirect outcomes — $name', ({ flag, viewer }) => {
  it('a model getById refuses is a 404, before any other prefetch', async () => {
    const { result, procs, cohort } = await run({ flag, viewer, getById: 'not-found' });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual(['fetch model.getById']);
    // A 404 is not a render of this page, so it is never counted in the A/B.
    expect(cohort).toBeUndefined();
  });

  it('a model with no version is a 404', async () => {
    m.version = null;
    const { result, procs } = await run({ flag, viewer });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
  });

  it('a non-numeric id is a 404', async () => {
    const { result, procs } = await run({ flag, viewer, id: 'abc' });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
  });

  it('a private model the viewer has no access to is a 404', async () => {
    m.version = {
      ...PUBLIC_VERSION,
      model: { ...PUBLIC_VERSION.model, availability: 'Private' },
    };
    m.hasAccess = false;
    const { result, procs } = await run({ flag, viewer });

    expect(result).toEqual({ notFound: true });
    expect(procs).toEqual([]);
  });

  it('a bare id redirects permanently to the canonical slug', async () => {
    const { result, procs, cohort } = await run({ flag, viewer, slug: null });

    expect(result).toEqual({
      redirect: { destination: `/models/${F.MODEL_ID}/${SLUG}`, permanent: true },
    });
    expect(procs).toEqual(['fetch model.getById']);
    expect(cohort).toBeUndefined();
  });

  it('a stale slug with a query redirects temporarily, keeping the query', async () => {
    const { result } = await run({
      flag,
      viewer,
      slug: ['old-name'],
      query: { modelVersionId: String(F.VERSION_IDS[0]) },
    });

    expect(result).toEqual({
      redirect: {
        destination: `/models/${F.MODEL_ID}/${SLUG}?modelVersionId=${F.VERSION_IDS[0]}`,
        permanent: false,
      },
    });
  });
});
