import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as TrpcMod from '~/utils/trpc';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The `trpcBatching` flag must be live before the FIRST commit's queries go out.
 *
 * React Query starts a mounted query's fetch from that component's effect, and React runs child
 * effects before parent effects. When `FeatureFlagsProvider` applied the flag only in its own
 * effect, every query mounted in the first commit was routed with batching still off. The probe
 * below stands in for such a query: it reads the routing decision from its mount effect.
 */

const mocks = vi.hoisted(() => ({
  // The per-user overlay — where a ramped flag actually arrives (host flags have it off).
  userFlags: { trpcBatching: true } as Record<string, boolean>,
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

const hostFlags = { trpcBatching: false } as unknown as FeatureAccess;

describe('FeatureFlagsProvider applies trpcBatching before descendants mount', () => {
  beforeEach(() => {
    setTrpcBatchingEnabled(false);
    // Signed-in browser, as `CivitaiSessionProvider` sets it while rendering.
    window.isAuthed = true;
    mocks.userFlags = { trpcBatching: true };
  });
  afterEach(() => {
    setTrpcBatchingEnabled(false);
    window.isAuthed = undefined;
  });

  test('a child mount effect already sees batching on', async () => {
    const seen = vi.fn();
    await renderWithProviders(
      <FeatureFlagsProvider flags={hostFlags}>
        <MountProbe onMount={seen} />
      </FeatureFlagsProvider>
    );
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ enabled: true, batch: true });
  });

  test('flag off for this user: a child mount effect sees batching off', async () => {
    // Negative control: the probe can report false, so the true above is not a constant.
    mocks.userFlags = { trpcBatching: false };
    const seen = vi.fn();
    await renderWithProviders(
      <FeatureFlagsProvider flags={hostFlags}>
        <MountProbe onMount={seen} />
      </FeatureFlagsProvider>
    );
    expect(seen).toHaveBeenCalledWith({ enabled: false, batch: false });
  });

  test('a later flag change still applies', async () => {
    const seen = vi.fn();
    const screen = await renderWithProviders(
      <FeatureFlagsProvider flags={hostFlags}>
        <MountProbe onMount={seen} />
      </FeatureFlagsProvider>
    );
    expect(getTrpcBatchingEnabled()).toBe(true);
    mocks.userFlags = { trpcBatching: false };
    await screen.rerender(
      <FeatureFlagsProvider flags={hostFlags}>
        <MountProbe onMount={seen} />
      </FeatureFlagsProvider>
    );
    expect(getTrpcBatchingEnabled()).toBe(false);
  });
});
