import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as TrpcMod from '~/utils/trpc';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * When `trpcBatching` reaches the tRPC link, relative to the first commit's queries. React Query
 * starts a query's fetch from a mount effect, and child effects run before parent effects; the
 * probe reads the routing decision from its own mount effect.
 *
 * Both flags are non-toggleable, so they arrive in the host `flags` prop (computed per user on
 * the server), not in the per-user toggleable overlay — the tests pass them the same way.
 *
 * `trpcBatchingFirstCommit` on: the provider writes `trpcBatching` while rendering, so the
 * probe's first effect already sees it. Off: only the provider's effect writes it, so the probe's
 * first effect still sees batching off, and it is on once the provider's effect has run.
 */

const mocks = vi.hoisted(() => ({
  // The per-user toggleable overlay, settled on frame 0 as when the server seeds it. Empty in
  // the production-path tests: neither batching flag is toggleable.
  userFlags: {} as Record<string, boolean>,
}));

vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({
    data: { user: { id: 1 } },
    status: 'authenticated',
    update: async () => null,
  }),
}));

// Real `setTrpcBatchingEnabled` / `shouldBatch` (the module state under test); only the hook
// client is stubbed, answering the per-user flag overlay as a settled query.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'user.getFeatureFlags': {
      useQuery: () => ({ data: mocks.userFlags, isSuccess: true, isError: false }),
    },
  }),
}));

// eslint-disable-next-line import/first
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
// eslint-disable-next-line import/first
import { getTrpcBatchingEnabled, setTrpcBatchingEnabled, shouldBatch } from '~/utils/trpc';

const ordinaryQuery = { type: 'query', path: 'model.getInfinite', input: {}, context: {} };

function MountProbe({
  onMount,
}: {
  onMount: (seen: { enabled: boolean; batch: boolean }) => void;
}) {
  useEffect(() => {
    onMount({ enabled: getTrpcBatchingEnabled(), batch: shouldBatch(ordinaryQuery) });
  }, [onMount]);
  return null;
}

function hostFlags(trpcBatching: boolean, trpcBatchingFirstCommit: boolean) {
  return { trpcBatching, trpcBatchingFirstCommit } as unknown as FeatureAccess;
}

async function renderProbe(flags: FeatureAccess) {
  const seen = vi.fn();
  const screen = await renderWithProviders(
    <FeatureFlagsProvider flags={flags}>
      <MountProbe onMount={seen} />
    </FeatureFlagsProvider>
  );
  return { seen, screen };
}

describe('FeatureFlagsProvider applies trpcBatching to the tRPC link', () => {
  beforeEach(() => {
    setTrpcBatchingEnabled(false);
    // Signed-in browser, as `CivitaiSessionProvider` sets it while rendering.
    window.isAuthed = true;
    mocks.userFlags = {};
  });
  afterEach(() => {
    setTrpcBatchingEnabled(false);
    window.isAuthed = undefined;
  });

  test('first-commit flag on: a child mount effect already sees batching on', async () => {
    const { seen } = await renderProbe(hostFlags(true, true));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ enabled: true, batch: true });
  });

  test('first-commit flag off: a child mount effect sees batching off, then it is on', async () => {
    // The previous path: only the provider's effect writes the flag, and it runs after the child's.
    const { seen } = await renderProbe(hostFlags(true, false));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ enabled: false, batch: false });
    expect(getTrpcBatchingEnabled()).toBe(true);
    expect(shouldBatch(ordinaryQuery)).toBe(true);
  });

  test('trpcBatching off: batching stays off with the first-commit flag on', async () => {
    // Start from `true` so only the render-time write can produce the `false` the child sees.
    setTrpcBatchingEnabled(true);
    const { seen } = await renderProbe(hostFlags(false, true));
    expect(seen).toHaveBeenCalledWith({ enabled: false, batch: false });
    expect(getTrpcBatchingEnabled()).toBe(false);
  });

  test('trpcBatching off: batching ends off with the first-commit flag off', async () => {
    // Start from `true` so only the provider's effect can produce the final `false`.
    setTrpcBatchingEnabled(true);
    await renderProbe(hostFlags(false, false));
    expect(getTrpcBatchingEnabled()).toBe(false);
  });

  // INVARIANT GUARD, not a production path: in production both flags are frozen for the SPA
  // session (the provider keeps its host `flags` in `useState`, and neither flag is in the
  // toggleable overlay). This pins that the provider's writers follow a changed
  // `trpcBatching` — i.e. the effect's dependency — by changing it through the overlay, the
  // only input the provider re-reads.
  test.each([true, false])(
    'invariant guard: a changed trpcBatching is re-applied (first-commit flag %s)',
    async (firstCommit) => {
      const { seen, screen } = await renderProbe(hostFlags(true, firstCommit));
      expect(getTrpcBatchingEnabled()).toBe(true);
      mocks.userFlags = { trpcBatching: false };
      await screen.rerender(
        <FeatureFlagsProvider flags={hostFlags(true, firstCommit)}>
          <MountProbe onMount={seen} />
        </FeatureFlagsProvider>
      );
      expect(getTrpcBatchingEnabled()).toBe(false);
    }
  );
});
