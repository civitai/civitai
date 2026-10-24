import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as TrpcMod from '~/utils/trpc';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * With `trpcBatchingFirstCommit` on, `FeatureFlagsProvider` applies `trpcBatching` to a
 * MODULE-level flag while it renders. On the server that module is shared by every concurrent
 * request, so a server render must never write it — one user's flag would leak into other
 * requests. Both flags are on here so only the browser guard can keep the write out.
 */

vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({
    data: { user: { id: 1 } },
    status: 'authenticated',
    update: async () => null,
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'user.getFeatureFlags': {
      useQuery: () => ({
        data: { trpcBatching: true, trpcBatchingFirstCommit: true },
        isSuccess: true,
        isError: false,
      }),
    },
  }),
}));

// eslint-disable-next-line import/first
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
// eslint-disable-next-line import/first
import { getTrpcBatchingEnabled, setTrpcBatchingEnabled } from '~/utils/trpc';

describe('FeatureFlagsProvider on the server', () => {
  afterEach(() => setTrpcBatchingEnabled(false));

  it('does not write the module-level batching flag during a server render', () => {
    expect(typeof window).toBe('undefined'); // really a server render
    setTrpcBatchingEnabled(false);
    const html = renderToString(
      createElement(
        FeatureFlagsProvider,
        {
          flags: { trpcBatching: true, trpcBatchingFirstCommit: true } as unknown as FeatureAccess,
        },
        createElement('span', null, 'child')
      )
    );
    expect(html).toContain('child'); // the provider really rendered
    expect(getTrpcBatchingEnabled()).toBe(false);
  });
});
