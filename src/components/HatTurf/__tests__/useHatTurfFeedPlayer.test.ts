// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The sort menu's Hat Turf section, the team chips and the Show chips all appear only for a
 * non-null player, so this hook is where the feed-sorts flag holds them back.
 */

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sortsFlag = false;
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ hatTurfFeedCard: true, hatTurfFeedSorts: sortsFlag }),
}));
vi.mock('~/components/HatTurf/useHatTurfFeed', () => ({
  useHatTurfFeed: () => ({ event: 'e', arm: 'control' }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({ useShowEventCosmetics: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'hatTurf.getStock': {
        useQuery: (_input: unknown, opts?: { enabled?: unknown }) => ({
          data: opts?.enabled ? { optedIn: true, creditedByTeam: { Blue: 1 } } : undefined,
        }),
      },
    }),
  };
});

const { useHatTurfFeedPlayer } = await import('~/components/HatTurf/useHatTurfFeedPlayer');

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => act(() => root?.unmount()));

function player() {
  let result: ReturnType<typeof useHatTurfFeedPlayer>;
  function Probe() {
    result = useHatTurfFeedPlayer();
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(Probe)));
  return result!;
}

describe('useHatTurfFeedPlayer', () => {
  it('is null with the feed-sorts flag off, for a joined player with the feed card on', () => {
    sortsFlag = false;
    expect(player()).toBeNull();
  });

  it('is the player with the feed-sorts flag on', () => {
    sortsFlag = true;
    expect(player()).toEqual({ event: 'e', teams: ['Blue'] });
  });
});
