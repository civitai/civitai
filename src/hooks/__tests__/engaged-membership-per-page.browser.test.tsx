import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as ModelCardContext from '~/components/Cards/ModelCardContext';
import type * as ReactModule from 'react';

/**
 * 🔴 THE DEFECT: a model card renders its body only near the viewport, so a feed's cards ask for
 * their engagement membership a row at a time as the user scrolls. Each row landed in its own batch
 * window, so one page of models cost one `user.getEngagedModelsByIds` request PER ROW. The feed and
 * the search hits list already hold every id on the page, so the page must cost ONE request.
 *
 * The cards here are probes that call the REAL `useEngagedModelMembership` (the hook `ModelCardStats`
 * reads), and the stub grid reveals them a row at a time — the in-view mount order the real grid
 * produces. The batcher, its window, the store and the persistence layer are all real; only the
 * network is recorded. Each reveal waits for the revealed cards to be KNOWN before revealing the
 * next row, so "the earlier request was already sent" is a state the test reaches, not a race.
 */
const h = vi.hoisted(() => {
  const requests: number[][] = [];
  const gate: { current: Promise<void> | null } = { current: null };
  /** How many of the next requests fail. */
  const failing = { current: 0 };
  const reviewed = new Set<number>();
  const reveal = {
    count: 0,
    listeners: new Set<() => void>(),
    set(n: number) {
      this.count = n;
      this.listeners.forEach((l) => l());
    },
  };
  return {
    requests,
    gate,
    reviewed,
    reveal,
    user: { current: { id: 7 } as { id: number } | null },
    feed: { models: [] as { id: number }[] },
    makeRevealGrid(React: typeof ReactModule) {
      return function RevealGrid({
        data,
        render: Card,
      }: {
        data: { id: number }[];
        render: ReactModule.ComponentType<{ data: { id: number } }>;
      }) {
        const count = React.useSyncExternalStore(
          (listener) => {
            reveal.listeners.add(listener);
            return () => void reveal.listeners.delete(listener);
          },
          () => reveal.count
        );
        return React.createElement(
          React.Fragment,
          null,
          ...data
            .slice(0, count)
            .map((item) => React.createElement(Card, { key: item.id, data: item }))
        );
      };
    },
    /** Hold every answer until the returned release is called. */
    holdResponses() {
      let release!: () => void;
      gate.current = new Promise<void>((r) => (release = r));
      return () => release();
    },
    failing,
    query: async ({ modelIds }: { modelIds: number[] }) => {
      requests.push([...modelIds]);
      await gate.current;
      if (failing.current > 0) {
        failing.current--;
        throw new Error('boom');
      }
      return { Recommended: modelIds.filter((id) => reviewed.has(id)) };
    },
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(),
    trpcVanilla: { user: { getEngagedModelsByIds: { query: h.query } } },
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user.current }));

// The probe card, and a grid that mounts it a row at a time.
vi.mock('~/components/Cards/ModelCard', async () => {
  const { useEngagedModelMembership } = await import('~/hooks/useEngagedModelMembership');
  return {
    ModelCard: ({ data }: { data: { id: number } }) => {
      const { isEngaged, isKnown } = useEngagedModelMembership(data.id);
      return (
        <span
          data-card={data.id}
          data-reviewed={String(isEngaged('Recommended'))}
          data-known={String(isKnown)}
        />
      );
    },
  };
});
vi.mock('~/components/MasonryColumns/MasonryGridVirtual', async () => ({
  MasonryGridVirtual: h.makeRevealGrid(await import('react')),
}));
vi.mock('~/components/MasonryColumns/MasonryGrid', async () => ({
  MasonryGrid: h.makeRevealGrid(await import('react')),
}));

// Sale badges are a separate lookup with their own tests; out of the way here.
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardContext>()),
  useModelSaleBadges: () => undefined,
}));

// ModelsInfinite's data sources.
vi.mock('~/components/Model/model.utils', () => ({
  useModelFilters: () => ({}),
  useQueryModels: () => ({
    models: h.feed.models,
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isRefetching: false,
    isFetching: false,
  }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/InView/InViewLoader', () => ({ InViewLoader: () => null }));
vi.mock('~/components/EndOfFeed/EndOfFeed', () => ({ EndOfFeed: () => null }));

// ModelsHitList's data sources, and the page module's other imports.
vi.mock('~/components/Search/search.utils2', () => ({
  useInfiniteHitsTransformed: () => ({
    hits: h.feed.models,
    showMore: () => undefined,
    isLastPage: true,
  }),
}));
vi.mock('react-instantsearch', () => ({
  useInstantSearch: () => ({ status: 'idle', uiState: {} }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({
    items: data,
    loadingPreferences: false,
    hiddenCount: 0,
  }),
}));
vi.mock('~/components/Decorations/useSearchEventDecorations', () => ({
  useSearchEventDecorations: (_hits: unknown, items: unknown) => items,
}));
vi.mock('~/components/Search/CustomSearchComponents', () => ({
  BrowsingLevelFilter: () => null,
  ChipRefinementList: () => null,
  ClearRefinements: () => null,
  DateRangeRefinement: () => null,
  SearchableMultiSelectRefinementList: () => null,
  SortBy: () => null,
}));
vi.mock('~/components/Search/SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('~/components/Search/SearchLayout', () => ({ SearchLayout: () => null }));
vi.mock('~/components/Search/TimeoutLoader', () => ({ TimeoutLoader: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({ settings: {} }),
}));

import { renderWithProviders } from '../../../test/component-setup';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { ModelsHitList } from '~/pages/search/models';
import {
  __resetEngagedMembershipBatcher,
  engagedMembershipBatcher,
} from '~/hooks/useEngagedModelMembership';
import {
  __resetEngagedModelsPersistenceForTests,
  flushEngagedModelsPersistence,
} from '~/store/engaged-models.persist';
import { useEngagedModelsStore } from '~/store/engaged-models.store';

/** Distinct, non-contiguous ids, so a union, a slice and a single row can never coincide. */
const PAGE = [101, 205, 309, 412, 517, 623, 731, 840, 952, 1063, 1177, 1290];
const NEXT_PAGE = [1404, 1519, 1633, 1748, 1862, 1977, 2081, 2196];
const ROW = 4;
/** Longer than the batcher's window, so a row that would get its own request has had time to. */
const PAST_WINDOW_MS = 300;

const cardsEl = () => [...document.querySelectorAll<HTMLElement>('[data-card]')];
const attr = (id: number, name: string) =>
  document.querySelector(`[data-card="${id}"]`)?.getAttribute(name);
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reveal ids a row at a time, each row only once the rows before it are known. */
async function scrollThrough(ids: number[], alreadyShown = 0) {
  for (let shown = alreadyShown + ROW; shown <= alreadyShown + ids.length; shown += ROW) {
    h.reveal.set(shown);
    await vi.waitFor(() => {
      expect(cardsEl()).toHaveLength(shown);
      for (const el of cardsEl()) expect(el.getAttribute('data-known')).toBe('true');
    });
  }
  await wait(PAST_WINDOW_MS);
}

const feed = () => <ModelsInfinite />;
const surfaces = [
  { name: 'model feed (ModelsInfinite)', element: feed },
  { name: 'search hits (ModelsHitList)', element: () => <ModelsHitList /> },
];

/** What a fresh tab keeps: only storage. */
function simulateReload() {
  flushEngagedModelsPersistence();
  __resetEngagedModelsPersistenceForTests();
  useEngagedModelsStore.getState().reset();
  __resetEngagedMembershipBatcher();
}

beforeEach(() => {
  window.localStorage.clear();
  __resetEngagedModelsPersistenceForTests();
  useEngagedModelsStore.getState().reset();
  __resetEngagedMembershipBatcher();
  h.requests.length = 0;
  h.gate.current = null;
  h.failing.current = 0;
  // The real backoff is seconds; the retry itself is what is under test, not its delay.
  engagedMembershipBatcher.scheduleRetry = (cb) => void setTimeout(cb, 20);
  h.reviewed.clear();
  h.reveal.count = ROW;
  h.user.current = { id: 7 };
  h.feed.models = PAGE.map((id) => ({ id }));
});

describe.each(surfaces)('engaged membership on the $name', ({ element }) => {
  const render = () => renderWithProviders(element());

  test('a page scrolled a row at a time costs ONE request, for the whole page', async () => {
    await render();
    await scrollThrough(PAGE);

    expect(h.requests).toHaveLength(1);
    expect(sorted(h.requests[0])).toEqual(sorted(PAGE));
  });

  test('rows that scroll in while the page request is in flight add no request', async () => {
    const release = h.holdResponses();
    await render();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));

    h.reveal.set(PAGE.length);
    await vi.waitFor(() => expect(cardsEl()).toHaveLength(PAGE.length));
    await wait(PAST_WINDOW_MS);
    release();
    await vi.waitFor(() => expect(attr(1290, 'data-known')).toBe('true'));

    expect(h.requests).toHaveLength(1);
  });

  test('the next page costs one more request, for only its new ids', async () => {
    const screen = await render();
    await scrollThrough(PAGE);

    h.feed.models = [...PAGE, ...NEXT_PAGE].map((id) => ({ id }));
    await screen.rerender(element());
    await scrollThrough(NEXT_PAGE, PAGE.length);

    expect(h.requests).toHaveLength(2);
    expect(sorted(h.requests[1])).toEqual(sorted(NEXT_PAGE));
  });

  test('a signed-out viewer sends no request at all', async () => {
    h.user.current = null;
    h.reveal.count = PAGE.length;
    await render();
    await vi.waitFor(() => expect(cardsEl()).toHaveLength(PAGE.length));
    await wait(PAST_WINDOW_MS);

    expect(h.requests).toHaveLength(0);
    // Interactive, not stuck loading: a signed-out click must reach the sign-in prompt.
    for (const id of PAGE) expect(attr(id, 'data-known')).toBe('true');
  });

  test('signing in on a loaded page asks once, for the page', async () => {
    h.user.current = null;
    h.reviewed.add(731);
    h.reveal.count = PAGE.length;
    const screen = await render();
    await vi.waitFor(() => expect(cardsEl()).toHaveLength(PAGE.length));

    h.user.current = { id: 7 };
    await screen.rerender(element());
    await vi.waitFor(() => expect(attr(731, 'data-reviewed')).toBe('true'));
    await wait(PAST_WINDOW_MS);
    expect(h.requests).toHaveLength(1);
    expect(sorted(h.requests[0])).toEqual(sorted(PAGE));
  });
});

// Properties of the shared store and batcher rather than of a surface, so run once.
describe('engaged membership after the page request', () => {
  const render = () => renderWithProviders(feed());

  test('a page that loaded is remembered across a reload (control for the next test)', async () => {
    h.reveal.count = PAGE.length;
    const screen = await render();
    await vi.waitFor(() => expect(attr(1290, 'data-known')).toBe('true'));
    await screen.unmount();
    simulateReload();

    await render();
    await vi.waitFor(() => expect(attr(1290, 'data-known')).toBe('true'));
    await wait(PAST_WINDOW_MS);
    expect(h.requests).toHaveLength(1);
  });

  test('a page whose request FAILED (and whose retry failed) is asked for again after a reload', async () => {
    h.failing.current = 2;
    h.reveal.count = PAGE.length;
    const screen = await render();
    // Usable after the error: a failed id reads known-not-engaged rather than loading forever.
    await vi.waitFor(() => expect(attr(1290, 'data-known')).toBe('true'));
    await screen.unmount();
    const sentBeforeReload = h.requests.length;
    simulateReload();

    await render();
    await vi.waitFor(() => expect(h.requests).toHaveLength(sentBeforeReload + 1));
    expect(sorted(h.requests[sentBeforeReload])).toEqual(sorted(PAGE));
  });

  test('signing out while the page request is in flight: its answer never reaches the signed-out page', async () => {
    h.reviewed.add(101);
    h.reveal.count = PAGE.length;
    const release = h.holdResponses();
    const screen = await render();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));

    h.user.current = null;
    await screen.rerender(feed());
    release();
    await wait(PAST_WINDOW_MS);

    expect(attr(101, 'data-reviewed')).toBe('false');
    expect(h.requests).toHaveLength(1);
  });
});
