// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Search hits come from the index, which carries no hats, so the search grids ask for them: during
 * the preview only a viewer the event's flag is on for, and from `startsAt` everyone, signed out
 * included, one request per page of hits. The home blocks' gate stops at `startsAt`; this one must
 * not.
 */
const state = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  results: [] as { data?: Record<number, unknown>; dataUpdatedAt: number }[],
  asked: [] as {
    input: { entityType: string; ids: number[] };
    opts: { staleTime: number; trpc: { context: { skipBatch: boolean } } };
  }[],
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.features }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook's one call is useQueries, and the stub must build its descriptors to see what was asked
  trpc: {
    useQueries: (build: (t: unknown) => unknown[]) => {
      const descriptors = build({
        cosmetic: {
          getEventDecorationsForSearch: (input: unknown, opts: unknown) => ({ input, opts }),
        },
      }) as typeof state.asked;
      state.asked = descriptors;
      return descriptors.map((_, i) => state.results[i] ?? { data: undefined, dataUpdatedAt: 0 });
    },
  },
}));

import {
  searchEventDecorationQuery,
  useSearchEventDecorations,
} from '~/components/Decorations/useSearchEventDecorations';
import { viewerEventDecorationQuery } from '~/components/Decorations/useViewerEventDecorations';
import { EVENT_DECORATION_DEFINITIONS } from '~/shared/constants/event-decoration.constants';

// Dates come from the definition, so the cases follow it when an event moves.
const [definition] = EVENT_DECORATION_DEFINITIONS;
const previewFrom = definition.previewFrom as Date;
const inPreview = new Date(previewFrom.getTime() + 60_000);
const atStart = new Date(definition.startsAt.getTime());
const longAfter = new Date(definition.startsAt.getTime() + 365 * 24 * 60 * 60 * 1000);
const beforePreview = new Date(previewFrom.getTime() - 1);
const flagged = { [definition.featureFlag as string]: true };

const hat = (id: number) => ({
  id,
  name: 'Party Cap',
  type: 'ContentDecoration',
  source: 'Claim',
  data: { type: 'hat', event: definition.event, url: 'hat.png' },
  equippedToId: id,
  equippedToType: 'Model',
});

describe('searchEventDecorationQuery', () => {
  const base = { entity: 'Model' as const, features: {}, now: atStart };

  it.each([
    ['a flagged viewer in the preview', { features: flagged, now: inPreview }],
    ['anyone at startsAt', {}],
    ['anyone after the event, while its hats are still worn', { now: longAfter }],
  ])('asks for %s', (_, override) => {
    expect(searchEventDecorationQuery([3, 1, 2], { ...base, ...override })).toEqual({
      entityType: 'Model',
      pages: [[1, 2, 3]],
    });
  });

  it.each([
    ['an unflagged viewer in the preview', { now: inPreview }],
    [
      'a viewer whose flag is explicitly false in the preview',
      { now: inPreview, features: { [definition.featureFlag as string]: false } },
    ],
    ['a flagged viewer before previewFrom', { now: beforePreview, features: flagged }],
  ])('asks nothing for %s', (_, override) => {
    expect(searchEventDecorationQuery([1, 2], { ...base, ...override })).toBeNull();
  });

  it('asks nothing for an empty grid', () => {
    expect(searchEventDecorationQuery([], base)).toBeNull();
  });

  it('asks once per page of 50 hits, each page sorted and deduped', () => {
    const hits = Array.from({ length: 120 }, (_, i) => 1000 - i);
    const pages = searchEventDecorationQuery(hits, base)?.pages ?? [];
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(pages[0]).toEqual([...hits.slice(0, 50)].sort((a, b) => a - b));
    expect(searchEventDecorationQuery([5, 3, 5], base)?.pages).toEqual([[3, 5]]);
  });

  it("never changes an earlier page's ids when more hits load", () => {
    const first = Array.from({ length: 50 }, (_, i) => 500 - i);
    const more = [...first, 1, 2, 3];
    const before = searchEventDecorationQuery(first, base)?.pages;
    const after = searchEventDecorationQuery(more, base)?.pages;
    expect(after?.[0]).toEqual(before?.[0]);
    expect(after?.[1]).toEqual([1, 2, 3]);
  });

  it('stays on from startsAt, where the home blocks stop', () => {
    // The two gates, side by side: the home blocks ask nothing from launch, search keeps asking.
    expect(
      viewerEventDecorationQuery([1], {
        entity: 'model',
        userId: 1,
        features: flagged,
        now: atStart,
      })
    ).toBeNull();
    expect(searchEventDecorationQuery([1], { ...base, features: flagged })).not.toBeNull();
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  const Probe = () => {
    result.current = useHook();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return {
    result,
    rerender: () => act(() => root.render(createElement(Probe))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useSearchEventDecorations', () => {
  const hits = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
  // One hit hidden by the viewer's preferences: the pages still follow the index's hits.
  const items = hits.filter((hit) => hit.id !== 2).map((hit) => ({ ...hit }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(atStart);
    state.features = {};
    state.results = [];
    state.asked = [];
  });
  afterEach(() => vi.useRealTimers());

  it('asks once per page, unbatched, and puts the hats on the cards', () => {
    const { result, rerender, unmount } = renderHook(() =>
      useSearchEventDecorations(hits, items, { entity: 'Model' })
    );
    expect(state.asked.map((x) => x.input)).toEqual([
      { entityType: 'Model', ids: hits.slice(0, 50).map((x) => x.id) },
      { entityType: 'Model', ids: hits.slice(50).map((x) => x.id) },
    ]);
    // Unbatched, or the edge refuses to cache it.
    for (const { opts } of state.asked) expect(opts.trpc.context.skipBatch).toBe(true);
    // Negative control: nothing has answered yet.
    expect(result.current).toBe(items);

    state.results = [
      { data: { 1: hat(1) }, dataUpdatedAt: 1 },
      { data: { 55: hat(55) }, dataUpdatedAt: 1 },
    ];
    rerender();
    const worn = result.current.filter((x) => 'eventDecoration' in x).map((x) => x.id);
    expect(worn).toEqual([1, 55]);
    unmount();
  });

  it('asks for the next page when more hits load, and merges a page that answers late', () => {
    let current = hits.slice(0, 50);
    const { result, rerender, unmount } = renderHook(() =>
      useSearchEventDecorations(current, current, { entity: 'Model' })
    );
    expect(state.asked).toHaveLength(1);
    const firstPage = state.asked[0].input;

    state.results = [{ data: { 1: hat(1) }, dataUpdatedAt: 1 }];
    current = hits;
    rerender();
    expect(state.asked.map((x) => x.input)).toEqual([
      firstPage,
      { entityType: 'Model', ids: hits.slice(50).map((x) => x.id) },
    ]);
    const wornNow = () => result.current.filter((x) => 'eventDecoration' in x).map((x) => x.id);
    expect(wornNow()).toEqual([1]);

    // Only the second page answers; the first page's result is unchanged.
    state.results = [
      { data: { 1: hat(1) }, dataUpdatedAt: 1 },
      { data: { 55: hat(55) }, dataUpdatedAt: 2 },
    ];
    rerender();
    expect(wornNow()).toEqual([1, 55]);
    unmount();
  });

  it('sends no request for an unflagged viewer in the preview', () => {
    vi.setSystemTime(inPreview);
    state.results = [{ data: { 1: hat(1) }, dataUpdatedAt: 1 }];
    const { result, unmount } = renderHook(() =>
      useSearchEventDecorations(hits, items, { entity: 'Model' })
    );
    expect(state.asked).toEqual([]);
    expect(result.current).toBe(items);
    unmount();
  });

  it('asks for a flagged viewer in the preview', () => {
    vi.setSystemTime(inPreview);
    state.features = flagged;
    const { unmount } = renderHook(() =>
      useSearchEventDecorations(hits, items, { entity: 'Model' })
    );
    expect(state.asked).toHaveLength(2);
    unmount();
  });
});

const readSource = (relative: string) =>
  readFileSync(path.resolve(__dirname, '../../..', relative), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );

/** The props of a JSX element's opening tag. */
function openingTag(source: string, tag: string) {
  const start = source.indexOf(`<${tag}`);
  expect(start, `<${tag}> not found`).toBeGreaterThan(-1);
  const firstLine = source.slice(start, source.indexOf('\n', start));
  if (firstLine.trimEnd().endsWith('>')) return firstLine;
  const close = source.slice(start).search(/\n\s*\/?>/);
  return source.slice(start, start + close);
}

describe('the search grids', () => {
  // Wiring only: the behaviour is pinned above. Each grid must render the decorated list, in every
  // element that hands the items to the cards.
  it.each([
    ['models', 'Model', [['MasonryGrid', 'data={decorated as any}']]],
    [
      'images',
      'Image',
      [
        ['ImagesProvider', 'images={decorated as any}'],
        ['MasonryColumnsVirtual', 'data={decorated as any}'],
      ],
    ],
    ['articles', 'Article', [['MasonryGridVirtual', 'data={decorated}']]],
  ])('%s asks for its hats and renders them', (page, entity, sites) => {
    const source = readSource(`pages/search/${page}.tsx`);
    const callAt = source.indexOf('const decorated = useSearchEventDecorations(');
    const call = source.slice(callAt, source.indexOf('\n', callAt)).trim();
    expect(call).toMatch(/^const decorated = useSearchEventDecorations\(hits, items\b/);
    expect(call).toContain(`{ entity: '${entity}' });`);
    // Above the first early return, or the hook count changes between renders.
    expect(callAt).toBeLessThan(source.indexOf('if (hits.length === 0)'));
    for (const [tag, prop] of sites) expect(openingTag(source, tag)).toContain(prop);
  });

  it('pages the index by the same size the hat lookup chunks by', () => {
    expect(readSource('components/Search/SearchLayout.tsx')).toContain(
      '<Configure hitsPerPage={SEARCH_HITS_PER_PAGE}'
    );
  });
});
