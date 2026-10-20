import { describe, expect, it, vi } from 'vitest';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as BrowsingLevelUtils from '~/server/utils/browsing-level';
import * as F from './model-page-fixture';

/**
 * The model page's `getServerSideProps` prefetches under `modelPageDeferBelowFold`.
 *
 * `createServerSideProps` is replaced by one that hands back the page's own resolver, which is then
 * driven with a recording `ssg` helper — so the assertions are over exactly the prefetches the
 * resolver issues, with their inputs, for one request.
 *
 * The flag must not change the prefetch set: `user.getCreator` is prefetched in BOTH states. Under
 * the flag the creator card renders client-side only, and the prefetch is what lets it mount from
 * the dehydrated cache with the real creator (one layout shift, not two).
 */

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getDefaultModelVersion: async () => ({
    id: F.VERSION_IDS[0],
    status: 'Published',
    availability: 'Public',
    trainingStatus: null,
    model: { id: F.MODEL_ID, userId: F.CREATOR_ID, availability: 'Public' },
  }),
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelUtils>()),
  getServerImageQueryFilters: async () => ({ excludedTagIds: [] }),
}));

const { getServerSideProps } = await import('~/pages/models/[id]/[[...slug]]');

type Call = { proc: string; method: string; input: unknown };

/** An `ssg` helper that records every `<router>.<procedure>.<method>(input)` call. */
function recordingSsg(calls: Call[]) {
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
                return router === 'model' && proc === 'getById' ? F.MODEL : null;
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

const SESSION = { user: { id: 5, username: 'lantern-viewer', isModerator: false } };

async function prefetchesFor(features: Record<string, boolean>) {
  const calls: Call[] = [];
  const resolver = getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  const result = await resolver({
    ssg: recordingSsg(calls),
    ctx: {
      params: { id: String(F.MODEL_ID), slug: ['lantern-glow-portrait-lora'] },
      query: { id: String(F.MODEL_ID), slug: ['lantern-glow-portrait-lora'] },
    },
    session: SESSION,
    features,
  });
  // A redirect or notFound would mean the fixture never reached the prefetch block at all.
  expect(result).toMatchObject({ props: { id: F.MODEL_ID } });
  return calls.sort((a, b) => a.proc.localeCompare(b.proc));
}

describe('model page getServerSideProps — modelPageDeferBelowFold', () => {
  it.each([false, true])(
    'flag %s: prefetches the creator card query for the model owner',
    async (flag) => {
      const calls = await prefetchesFor({ modelPageDeferBelowFold: flag });

      expect(calls.filter((c) => c.proc === 'user.getCreator')).toEqual([
        { proc: 'user.getCreator', method: 'prefetch', input: { id: F.CREATOR_ID } },
      ]);
    }
  );

  it('ON: issues exactly the prefetches OFF does', async () => {
    const off = await prefetchesFor({ modelPageDeferBelowFold: false });
    const on = await prefetchesFor({ modelPageDeferBelowFold: true });

    expect(on).toEqual(off);
    // The prefetch set the comparison above runs over — so it cannot pass on two empty lists.
    expect(on.map((c) => c.proc)).toEqual([
      'blocks.listForModel',
      'common.getEntityAccess',
      'hiddenPreferences.getHidden',
      'image.getInfinite',
      'model.getById',
      'model.getCollectionShowcase',
      'resourceReview.getUserResourceReview',
      'user.getCreator',
      'user.getEngagedModelVersions',
    ]);
  });
});
