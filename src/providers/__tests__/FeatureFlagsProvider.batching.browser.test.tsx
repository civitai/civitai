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
 * probe reads the routing decision from its own mount effect. The overlay is settled on frame 0,
 * as when the server seeds the per-user flags.
 *
 * `trpcBatchingFirstCommit` on: the provider writes `trpcBatching` while rendering, so the
 * probe's first effect already sees it. Off: only the provider's effect writes it, so the probe's
 * first effect still sees batching off, and it is on once the provider's effect has run.
 */

const mocks = vi.hoisted(() => ({
  // The per-user overlay — where a ramped flag actually arrives (host flags have it off).
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

const hostFlags = {
  trpcBatching: false,
  trpcBatchingFirstCommit: false,
} as unknown as FeatureAccess;

async function renderProbe() {
  const seen = vi.fn();
  const screen = await renderWithProviders(
    <FeatureFlagsProvider flags={hostFlags}>
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
    mocks.userFlags = { trpcBatching: true, trpcBatchingFirstCommit: true };
  });
  afterEach(() => {
    setTrpcBatchingEnabled(false);
    window.isAuthed = undefined;
  });

  test('first-commit flag on: a child mount effect already sees batching on', async () => {
    const { seen } = await renderProbe();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ enabled: true, batch: true });
  });

  test('first-commit flag off: a child mount effect sees batching off, then it is on', async () => {
    // The previous path: only the provider's effect writes the flag, and it runs after the child's.
    mocks.userFlags = { trpcBatching: true, trpcBatchingFirstCommit: false };
    const { seen } = await renderProbe();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ enabled: false, batch: false });
    expect(getTrpcBatchingEnabled()).toBe(true);
    expect(shouldBatch(ordinaryQuery)).toBe(true);
  });

  test('trpcBatching off: batching stays off with the first-commit flag on', async () => {
    mocks.userFlags = { trpcBatching: false, trpcBatchingFirstCommit: true };
    // Start from `true` so only the render-time write can produce the `false` the child sees.
    setTrpcBatchingEnabled(true);
    const { seen } = await renderProbe();
    expect(seen).toHaveBeenCalledWith({ enabled: false, batch: false });
    expect(getTrpcBatchingEnabled()).toBe(false);
  });

  test('trpcBatching off: batching ends off with the first-commit flag off', async () => {
    mocks.userFlags = { trpcBatching: false, trpcBatchingFirstCommit: false };
    // Start from `true` so only the provider's effect can produce the final `false`.
    setTrpcBatchingEnabled(true);
    await renderProbe();
    expect(getTrpcBatchingEnabled()).toBe(false);
  });

  test.each([true, false])(
    'a later trpcBatching change still applies (first-commit flag %s)',
    async (firstCommit) => {
      mocks.userFlags = { trpcBatching: true, trpcBatchingFirstCommit: firstCommit };
      const { seen, screen } = await renderProbe();
      expect(getTrpcBatchingEnabled()).toBe(true);
      mocks.userFlags = { trpcBatching: false, trpcBatchingFirstCommit: firstCommit };
      await screen.rerender(
        <FeatureFlagsProvider flags={hostFlags}>
          <MountProbe onMount={seen} />
        </FeatureFlagsProvider>
      );
      expect(getTrpcBatchingEnabled()).toBe(false);
    }
  );
});
