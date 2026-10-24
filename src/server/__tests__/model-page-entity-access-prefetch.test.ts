import { hashKey } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type * as ModelVersionService from '~/server/services/model-version.service';

/**
 * `/models/<id>` SSR prefetches `common.getEntityAccess` so the version's access state hydrates
 * instead of being fetched again on the client. That only works if the prefetch input produces the
 * same React Query key as the client's `useModelVersionPermission` query. The key is built from the
 * RAW input, so `entityId: 5` and `entityId: [5]` are different cache entries even though the
 * procedure's schema accepts both.
 */

type Resolver = (ctx: unknown) => Promise<{ redirect?: unknown; notFound?: boolean }>;

const captured = vi.hoisted(() => ({ resolver: undefined as Resolver | undefined }));
const getDefaultModelVersionMock = vi.hoisted(() => vi.fn());

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: Resolver }) => {
    captured.resolver = resolver;
    return vi.fn();
  },
}));

vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getDefaultModelVersion: (...args: unknown[]) => getDefaultModelVersionMock(...args),
}));

import '~/pages/models/[id]/[[...slug]]';
import { modelVersionAccessInput } from '~/components/Model/ModelVersions/model-version.utils';

const MODEL_ID = 4201;
const VERSION_ID = 9137;
const SLUG = 'lantern-glow';

// tRPC's query key for a procedure call: [path, { input, type }]. React Query identifies cache
// entries by hashKey of that array.
const entityAccessKey = (input: unknown) =>
  hashKey([['common', 'getEntityAccess'], { input, type: 'query' }]);

const runSsr = async (query: Record<string, string> = {}) => {
  if (!captured.resolver) throw new Error('resolver was never captured');
  getDefaultModelVersionMock.mockResolvedValue({ id: VERSION_ID, model: { id: MODEL_ID } });

  const prefetch = () => vi.fn(async () => undefined);
  const entityAccessPrefetch = prefetch();
  const ssg = {
    model: {
      getById: {
        fetch: vi.fn(async () => ({
          id: MODEL_ID,
          name: 'Lantern Glow',
          nsfwLevel: 1,
          nsfw: false,
          status: 'Published',
          type: 'LORA',
          user: { id: 31 },
        })),
      },
      getCollectionShowcase: { prefetch: prefetch() },
    },
    hiddenPreferences: { getHidden: { prefetch: prefetch() } },
    common: { getEntityAccess: { prefetch: entityAccessPrefetch } },
    user: {
      getCreator: { prefetch: prefetch() },
      getEngagedModelVersions: { prefetch: prefetch() },
    },
    resourceReview: { getUserResourceReview: { prefetch: prefetch() } },
    blocks: { listForModel: { prefetch: prefetch() } },
    image: { getInfinite: { prefetchInfinite: prefetch() } },
  };

  const result = await captured.resolver({
    ctx: { params: { id: String(MODEL_ID), slug: [SLUG] }, query },
    ssg,
    session: null,
    features: {},
  });
  return { result, entityAccessPrefetch };
};

describe('model page getEntityAccess prefetch', () => {
  it('prefetches under the same query key the client permission hook reads', async () => {
    const { result, entityAccessPrefetch } = await runSsr();

    expect(result.redirect).toBeUndefined();
    expect(entityAccessPrefetch).toHaveBeenCalledTimes(1);
    const [prefetchInput] = entityAccessPrefetch.mock.calls[0] as unknown as [unknown];
    expect(entityAccessKey(prefetchInput)).toBe(
      entityAccessKey(modelVersionAccessInput(VERSION_ID))
    );
    // Pinned literally: invalidations and other callers of this procedure use the array shape.
    expect(prefetchInput).toEqual({ entityId: [VERSION_ID], entityType: 'ModelVersion' });
  });

  it('uses the requested version when the URL names one', async () => {
    const requested = 7713;
    const { entityAccessPrefetch } = await runSsr({ modelVersionId: String(requested) });

    const [prefetchInput] = entityAccessPrefetch.mock.calls[0] as unknown as [unknown];
    expect(prefetchInput).toEqual({ entityId: [requested], entityType: 'ModelVersion' });
  });

  it('control: a scalar entityId keys a different cache entry than the array form', () => {
    expect(entityAccessKey({ entityId: VERSION_ID, entityType: 'ModelVersion' })).not.toBe(
      entityAccessKey({ entityId: [VERSION_ID], entityType: 'ModelVersion' })
    );
  });
});
