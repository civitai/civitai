import { describe, expect, it, vi } from 'vitest';
import { OUTSIDE_TRIAL, recordingSsg, SIGNED_IN, trialRequest } from '../ssr-skip-prefetch.fixture';

/**
 * `/user/[username]`'s `getServerSideProps` under `ssrSignedInSkipPrefetchUser`.
 *
 * - Flag ON + signed in: the profile, its overview and (on a `?milestone=` link) the milestone
 *   check — what the layout's NotFound, its blocked-by-them panel and every `<head>` tag read — and
 *   no `user.getCreator`; the page gets `deferredSsr: true`.
 * - Flag OFF, the model page's flag, anonymous, a verified bot, a bot-cache candidate or a
 *   `/_next/data` request: the full prefetch set and the props exactly as before (no `deferredSsr`).
 */

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));

const { getServerSideProps } = await import('~/pages/user/[username]/index');

const PROFILE_ID = 42;

async function run({
  features,
  signedIn = true,
  query = {},
  url = '/user/Lantern',
  headers,
  marks,
}: {
  features: Record<string, boolean>;
  signedIn?: boolean;
  query?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  marks?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const request = trialRequest({ url, headers, marks });
  const resolver = getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  const result = await resolver({
    ssg: recordingSsg(calls, { 'userProfile.get': () => ({ id: PROFILE_ID }) }),
    ctx: {
      params: { username: 'Lantern' },
      query: { username: 'Lantern', ...query },
      req: request.req,
      res: {},
    },
    session: signedIn ? SIGNED_IN : null,
    features,
  });
  return { result, procs: calls.sort(), cohort: request.cohort(), route: request.route() };
}

const ON = { ssrSignedInSkipPrefetchUser: true };
const OFF = { ssrSignedInSkipPrefetchUser: false };

const FULL = [
  'prefetch user.getCreator',
  'prefetch userProfile.get',
  'prefetch userProfile.overview',
];
const SKIP = FULL.filter((p) => p !== 'prefetch user.getCreator');

// The props carry the slugified name, as before.
const page = (deferredSsr: boolean) => ({
  props: { username: 'lantern', ...(deferredSsr ? { deferredSsr: true } : {}) },
});

describe('profile page getServerSideProps — ssrSignedInSkipPrefetchUser', () => {
  it('ON + signed in: no creator card, and the layout renders its shell', async () => {
    const { result, procs, cohort, route } = await run({ features: ON });

    expect(procs).toEqual(SKIP);
    expect(result).toEqual(page(true));
    expect(cohort).toBe('skip');
    expect(route).toBe('/user/[username]');
  });

  it('OFF + signed in: the full prefetch set, and the props exactly as before', async () => {
    const { result, procs, cohort } = await run({ features: OFF });

    expect(procs).toEqual(FULL);
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
      features: { ssrSignedInSkipPrefetchUser: flag },
      signedIn: false,
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

  // A shared milestone link's og:image is the card, decided on the server (`ProfileLayout2`).
  const MILESTONE_FULL = [
    'fetch userProfile.get',
    'prefetch creatorJourney.isMilestoneShareable',
    'prefetch user.getCreator',
    'prefetch userProfile.overview',
  ];
  it.each([
    ['ON + signed in', ON, MILESTONE_FULL.filter((p) => p !== 'prefetch user.getCreator')],
    ['OFF + signed in', OFF, MILESTONE_FULL],
  ])('%s, ?milestone=: the milestone check is prefetched', async (_, features, expected) => {
    const { procs } = await run({ features, query: { milestone: 'legend' } });

    expect(procs).toEqual(expected);
  });
});
