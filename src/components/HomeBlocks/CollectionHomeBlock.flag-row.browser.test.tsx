import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

// The Flag Race row is one Collection home block. Between race days its Collection is empty, and the
// whole block, title and all, must disappear rather than show a header over nothing. On a race day
// every flag shows, and the header links to the flag Crucible open for entries, when there is one.

const h = vi.hoisted(() => ({
  items: [] as { type: 'image'; data: { id: number } }[],
  open: null as { id: number; endAt: Date } | null,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ flagRace: true, articles: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'homeBlock.getHomeBlock': {
        useQuery: () => ({
          data: { id: 1, collection: { id: 9, name: 'Flag Race', mode: null, items: h.items } },
          isLoading: false,
        }),
      },
      'hatTurf.getFlags': { useQuery: () => ({ data: null }) },
      'hatTurf.getOpenFlagCrucible': {
        useQuery: () => ({ data: h.open, refetch: async () => undefined }),
      },
    }),
  };
});
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({
    items: data,
    loadingPreferences: false,
  }),
}));
vi.mock('~/components/Reaction/useHydratedImageReactions', () => ({
  useHydratedImageReactions: (items: unknown) => items,
}));
vi.mock('~/components/Decorations/useViewerEventDecorations', () => ({
  useViewerEventDecorations: (items: unknown) => items,
}));
vi.mock('~/components/Cards/ImageCard', () => ({
  ImageCard: ({ data }: { data: { id: number } }) => <div data-testid="flag-card">{data.id}</div>,
}));

import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { renderWithProviders } from '../../../test/component-setup';

const block = () =>
  renderWithProviders(
    <MasonryProvider columnWidth={300} maxColumnCount={4}>
      <div data-testid="home">
        <CollectionHomeBlock
          homeBlockId={1}
          blockIndex={0}
          metadata={
            { title: 'Flag Race', collection: { id: 9, flagRace: 'birthday2026' } } as never
          }
        />
      </div>
    </MasonryProvider>
  );

const flags = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: 'image' as const, data: { id: 101 + i } }));
const enter = () => document.querySelector<HTMLAnchorElement>('[data-testid="flag-race-enter"]');

afterEach(() => {
  cleanup();
  h.open = null;
});

describe('the Flag Race home row', () => {
  test('hides entirely, title included, on a day with no flags', async () => {
    h.items = [];
    block();
    await new Promise((r) => setTimeout(r, 200));
    const home = document.querySelector('[data-testid="home"]') as HTMLElement;
    expect(home.textContent).not.toContain('Flag Race');
    expect(home.innerHTML).toBe('');
  });

  test('shows its title and flags once the day has flags', async () => {
    h.items = [
      { type: 'image', data: { id: 101 } },
      { type: 'image', data: { id: 102 } },
    ];
    block();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="flag-card"]').length).toBe(2)
    );
    expect(document.querySelector('[data-testid="home"]')?.textContent).toContain('Flag Race');
  });

  test("shows every one of the day's ten flags, not one row's worth", async () => {
    h.items = flags(10);
    block();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="flag-card"]').length).toBe(10)
    );
  });

  test('links Enter the race to the flag Crucible open now', async () => {
    h.items = flags(2);
    h.open = { id: 389, endAt: new Date(Date.now() + 60 * 60_000) };
    block();
    await vi.waitFor(() => expect(enter()?.getAttribute('href')).toBe('/crucibles/389'));
    expect(enter()?.textContent).toBe('Enter the race');
  });

  test('has no Enter the race with no flag Crucible open', async () => {
    h.items = flags(2);
    block();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="flag-card"]').length).toBe(2)
    );
    expect(enter()).toBeNull();
  });

  test('drops Enter the race once the open Crucible has ended', async () => {
    h.items = flags(2);
    h.open = { id: 389, endAt: new Date(Date.now() - 1_000) };
    block();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="flag-card"]').length).toBe(2)
    );
    expect(enter()).toBeNull();
  });
});
