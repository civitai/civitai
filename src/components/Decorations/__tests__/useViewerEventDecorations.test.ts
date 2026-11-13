// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Home blocks are served from a cache every viewer shares, fetched with no viewer, so before an
 * event's start they carry no hats. `useViewerEventDecorations` asks for the viewer's own, but only
 * a viewer the event's flag is on for, and only during the preview: it runs for all homepage
 * traffic, and from `startsAt` the shared payload carries the hats itself.
 */
const VIEWER = 501;

const state = vi.hoisted(() => ({
  user: { id: 501 } as { id: number } | undefined,
  features: {} as Record<string, boolean>,
  results: [] as { data?: Record<number, unknown>; dataUpdatedAt: number }[],
  asked: [] as { input: { entityType: string; ids: number[] }; opts: { staleTime: number } }[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.features }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook's one call is useQueries, and the stub must build its descriptors to see what was asked
  trpc: {
    useQueries: (build: (t: unknown) => unknown[]) => {
      const descriptors = build({
        cosmetic: {
          getViewerEventDecorations: (input: unknown, opts: unknown) => ({ input, opts }),
        },
      }) as typeof state.asked;
      state.asked = descriptors;
      // One result per descriptor, as the real `useQueries` gives: a surface that asked nothing
      // gets nothing, so a gate that leaks shows up as a hat, not only as a request.
      return descriptors.map((_, i) => state.results[i] ?? { data: undefined, dataUpdatedAt: 0 });
    },
  },
}));

import {
  mergeViewerEventDecorations,
  useViewerEventDecorations,
  viewerEventDecorationQuery,
} from '~/components/Decorations/useViewerEventDecorations';
import {
  EVENT_DECORATION_DEFINITIONS,
  getPreviewEventDecoration,
} from '~/shared/constants/event-decoration.constants';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

// Dates come from the definition, so the cases follow it when an event moves.
const [definition] = EVENT_DECORATION_DEFINITIONS;
const previewFrom = definition.previewFrom as Date;
const inPreview = new Date(previewFrom.getTime() + 60_000);
const atStart = new Date(definition.startsAt.getTime());
const beforePreview = new Date(previewFrom.getTime() - 1);
const flagged = { [definition.featureFlag as string]: true };

const hat = (id: number) => ({
  id,
  name: 'Party Cap',
  type: 'ContentDecoration',
  source: 'Claim',
  data: { type: 'hat', event: definition.event, url: 'hat.png' },
  equippedToId: 1,
  equippedToType: 'Image',
});

describe('getPreviewEventDecoration', () => {
  it('is set only from previewFrom until startsAt', () => {
    expect(getPreviewEventDecoration(CosmeticEntity.Image, beforePreview)).toBeUndefined();
    expect(getPreviewEventDecoration(CosmeticEntity.Image, previewFrom)).toBe(definition);
    expect(getPreviewEventDecoration(CosmeticEntity.Image, inPreview)).toBe(definition);
    expect(getPreviewEventDecoration(CosmeticEntity.Image, atStart)).toBeUndefined();
  });
});

describe('viewerEventDecorationQuery', () => {
  const base = { entity: 'image' as const, userId: VIEWER, features: flagged, now: inPreview };

  it('asks for a flagged viewer during the preview', () => {
    expect(viewerEventDecorationQuery([3, 1, 2], base)).toEqual({
      entityType: CosmeticEntity.Image,
      chunks: [[1, 2, 3]],
    });
  });

  it.each([
    ['signed out', { userId: undefined }],
    ['signed in, flag off', { features: {} }],
    [
      'signed in, flag explicitly false',
      { features: { [definition.featureFlag as string]: false } },
    ],
    ['at startsAt', { now: atStart }],
    ['before previewFrom', { now: beforePreview }],
    ['posts, which wear nothing', { entity: 'post' as const }],
  ])('asks nothing: %s', (_, override) => {
    expect(viewerEventDecorationQuery([1, 2], { ...base, ...override })).toBeNull();
  });

  it('asks nothing for an empty pool', () => {
    expect(viewerEventDecorationQuery([], base)).toBeNull();
  });

  it('maps each entity to its own type', () => {
    expect(viewerEventDecorationQuery([1], { ...base, entity: 'model' })?.entityType).toBe(
      CosmeticEntity.Model
    );
    expect(viewerEventDecorationQuery([1], { ...base, entity: 'article' })?.entityType).toBe(
      CosmeticEntity.Article
    );
  });

  it('keeps each chunk within the server cap', () => {
    const ids = Array.from({ length: 150 }, (_, i) => 150 - i);
    const query = viewerEventDecorationQuery(ids, base);
    expect(query?.chunks.map((c) => c.length)).toEqual([100, 50]);
    expect(query?.chunks[1][0]).toBe(101);
  });
});

describe('mergeViewerEventDecorations', () => {
  it('fills an item the shared payload left bare', () => {
    const items = [{ id: 1, eventDecoration: null }, { id: 2 }];
    const merged = mergeViewerEventDecorations(items, { 1: hat(1), 2: hat(2) } as never);
    expect(merged.map((x) => x.eventDecoration?.id)).toEqual([1, 2]);
  });

  it('never replaces a hat the payload already carries', () => {
    const own = hat(7);
    const items = [{ id: 1, eventDecoration: own }];
    const merged = mergeViewerEventDecorations(items as never, { 1: hat(1) } as never);
    expect((merged[0] as { eventDecoration: unknown }).eventDecoration).toBe(own);
    expect(merged).toBe(items);
  });

  it('returns the same array when there is nothing to add', () => {
    const items = [{ id: 1, eventDecoration: null }];
    expect(mergeViewerEventDecorations(items, {})).toBe(items);
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

describe('useViewerEventDecorations', () => {
  const items = [{ id: 11, eventDecoration: null }];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(inPreview);
    state.user = { id: VIEWER };
    state.features = flagged;
    state.results = [];
    state.asked = [];
  });
  afterEach(() => vi.useRealTimers());

  it('gives a flagged viewer their preview hat', () => {
    const { result, rerender, unmount } = renderHook(() =>
      useViewerEventDecorations(items, { entity: 'image' })
    );
    expect(state.asked).toEqual([
      { input: { entityType: CosmeticEntity.Image, ids: [11] }, opts: { staleTime: 60_000 } },
    ]);
    // Negative control: nothing has answered yet.
    expect(result.current[0].eventDecoration).toBeNull();

    state.results = [{ data: { 11: hat(11) }, dataUpdatedAt: 1 }];
    rerender();
    expect(result.current[0].eventDecoration?.id).toBe(11);
    unmount();
  });

  it.each([
    ['a signed-in viewer the flag is off for', () => (state.features = {})],
    ['a signed-out viewer', () => (state.user = undefined)],
    ['anyone from startsAt', () => vi.setSystemTime(atStart)],
  ])('sends no request for %s', (_, arrange) => {
    arrange();
    state.results = [{ data: { 11: hat(11) }, dataUpdatedAt: 1 }];
    const { result, unmount } = renderHook(() =>
      useViewerEventDecorations(items, { entity: 'image' })
    );
    expect(state.asked).toEqual([]);
    expect(result.current).toBe(items);
    unmount();
  });

  it('starts asking when the flag arrives after mount', () => {
    // A signed-in viewer's per-user flags can land after the first render.
    state.features = {};
    const { result, rerender, unmount } = renderHook(() =>
      useViewerEventDecorations(items, { entity: 'image' })
    );
    expect(state.asked).toEqual([]);

    state.features = flagged;
    state.results = [{ data: { 11: hat(11) }, dataUpdatedAt: 1 }];
    rerender();
    expect(state.asked).toHaveLength(1);
    expect(result.current[0].eventDecoration?.id).toBe(11);
    unmount();
  });

  it('stops asking when the viewer signs out', () => {
    const { result, rerender, unmount } = renderHook(() =>
      useViewerEventDecorations(items, { entity: 'image' })
    );
    expect(state.asked).toHaveLength(1);

    state.user = undefined;
    state.results = [{ data: { 11: hat(11) }, dataUpdatedAt: 1 }];
    rerender();
    expect(state.asked).toEqual([]);
    expect(result.current).toBe(items);
    unmount();
  });

  it('merges every chunk, and a chunk that answers later', () => {
    const pool = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, eventDecoration: null }));
    state.results = [
      { data: { 1: hat(1) }, dataUpdatedAt: 1 },
      { data: undefined, dataUpdatedAt: 0 },
    ];
    const { result, rerender, unmount } = renderHook(() =>
      useViewerEventDecorations(pool, { entity: 'image' })
    );
    expect(state.asked.map((x) => x.input.ids.length)).toEqual([100, 50]);
    expect(state.asked[1].input.ids[0]).toBe(101);
    expect(result.current[0].eventDecoration?.id).toBe(1);
    expect(result.current[149].eventDecoration).toBeNull();

    // Only the second chunk changes.
    state.results = [
      { data: { 1: hat(1) }, dataUpdatedAt: 1 },
      { data: { 150: hat(150) }, dataUpdatedAt: 2 },
    ];
    rerender();
    expect(result.current[0].eventDecoration?.id).toBe(1);
    expect(result.current[149].eventDecoration?.id).toBe(150);
    unmount();
  });

  it('asks once the pool arrives after the first render', () => {
    // Every block's first render hands over `[]` while hidden preferences load.
    const pool = { current: [] as { id: number; eventDecoration: null }[] };
    const { result, rerender, unmount } = renderHook(() =>
      useViewerEventDecorations(pool.current, { entity: 'model' })
    );
    expect(state.asked).toEqual([]);

    pool.current = [{ id: 21, eventDecoration: null }];
    state.results = [{ data: { 21: hat(21) }, dataUpdatedAt: 1 }];
    rerender();
    expect(state.asked.map((x) => x.input)).toEqual([
      { entityType: CosmeticEntity.Model, ids: [21] },
    ]);
    expect(result.current[0].eventDecoration?.id).toBe(21);
    unmount();
  });
});
