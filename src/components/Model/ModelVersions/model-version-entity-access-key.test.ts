import { describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The client side of the model page's `common.getEntityAccess` contract: the permission hook's
 * query and the early-access purchase invalidation must use the same input the page's SSR
 * prefetch writes (pinned in `src/server/__tests__/model-page-entity-access-prefetch.test.ts`).
 * Both files pin the same literal, so the SSR and client keys can only drift apart by breaking
 * one of them.
 */

const VERSION_ID = 9137;
const EXPECTED = { entityId: [VERSION_ID], entityType: 'ModelVersion' };

const spies = vi.hoisted(() => ({
  entityAccessUseQuery: vi.fn((..._args: unknown[]) => ({ data: undefined, isLoading: false })),
  entityAccessInvalidate: vi.fn(),
  earlyAccessUseMutation: vi.fn((..._args: unknown[]) => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'common.getEntityAccess': { useQuery: spies.entityAccessUseQuery },
        'modelVersion.earlyAccessPurchase': { useMutation: spies.earlyAccessUseMutation },
      },
      {
        useUtils: () => ({
          common: { getEntityAccess: { invalidate: spies.entityAccessInvalidate } },
          modelVersion: { donationGoal: { invalidate: vi.fn() } },
        }),
      }
    ),
  };
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

import {
  useModelVersionPermission,
  useMutateModelVersion,
} from '~/components/Model/ModelVersions/model-version.utils';

describe('model version entity-access query input', () => {
  it('the permission hook queries with the array shape the SSR prefetch writes', () => {
    useModelVersionPermission({ modelVersionId: VERSION_ID });

    expect(spies.entityAccessUseQuery).toHaveBeenCalledTimes(1);
    expect(spies.entityAccessUseQuery.mock.calls[0]?.[0]).toEqual(EXPECTED);
  });

  it('an early-access purchase invalidates that same entry', () => {
    useMutateModelVersion();
    const opts = spies.earlyAccessUseMutation.mock.calls[0]?.[0] as {
      onSuccess: (data: unknown, input: { modelVersionId: number }) => void;
    };

    opts.onSuccess(undefined, { modelVersionId: VERSION_ID });

    expect(spies.entityAccessInvalidate).toHaveBeenCalledWith(EXPECTED);
  });
});
