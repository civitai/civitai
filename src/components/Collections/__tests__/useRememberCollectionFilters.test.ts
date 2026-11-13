// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Query = Record<string, string | string[]>;

const router = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    isReady: true,
    pathname: '/collections/[collectionId]',
    query: {} as Record<string, string | string[]>,
    replaceCalls: 0,
    defer: false,
    pending: null as null | { query: Record<string, string | string[]> },
    apply: (target: { query: Record<string, string | string[]> }) => {
      state.query = target.query;
      state.snapshot = { ...state };
      listeners.forEach((l) => l());
    },
    replace: (target: { query: Record<string, string | string[]> }) => {
      state.replaceCalls++;
      if (state.defer) state.pending = target;
      else state.apply(target);
      return Promise.resolve(true);
    },
    snapshot: null as unknown,
  };
  state.snapshot = { ...state };
  return {
    state,
    navigate(query: Record<string, string | string[]>) {
      state.query = query;
      state.snapshot = { ...state };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
});

vi.mock('next/router', async () => {
  const React = await import('react');
  return {
    useRouter: () =>
      React.useSyncExternalStore(
        router.subscribe,
        () => router.state.snapshot,
        () => router.state.snapshot
      ),
  };
});

const { FiltersProvider } = await import('~/providers/FiltersProvider');
const { useRememberCollectionFilters } = await import(
  '~/components/Collections/useRememberCollectionFilters'
);

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof useRememberCollectionFilters>[0];
function Probe(props: Props) {
  useRememberCollectionFilters(props);
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(props: Props) {
  act(() =>
    root?.render(React.createElement(FiltersProvider, null, React.createElement(Probe, props)))
  );
}

function open(collectionId: number, query: Query, props?: Partial<Props>) {
  act(() => router.navigate({ collectionId: String(collectionId), ...query }));
  render({ type: 'models', collectionId, isContest: false, ...props });
}

const storedQuery = (key: string) => JSON.parse(localStorage.getItem(key) ?? '{}').query;

beforeEach(() => {
  localStorage.clear();
  router.state.replaceCalls = 0;
  router.state.defer = false;
  router.state.pending = null;
  router.state.isReady = true;
  router.navigate({});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useRememberCollectionFilters', () => {
  it('waits for the address and the collection to agree before touching the remembered value', () => {
    open(1, { sort: 'Oldest' });
    act(() => router.navigate({ collectionId: '2' }));

    expect(storedQuery('collection-model-filters')).toEqual({ sort: 'Oldest' });
  });

  it('brings the sort and filters set on one collection to the next of the same type', () => {
    open(1, {});
    act(() => router.navigate({ collectionId: '1', sort: 'Oldest', baseModels: ['Pony'] }));

    open(2, {});

    expect(router.state.query).toEqual({
      collectionId: '2',
      sort: 'Oldest',
      baseModels: ['Pony'],
    });
  });

  it('leaves an address that carries its own sort alone, and remembers it', () => {
    open(1, { sort: 'Oldest' });
    open(2, { sort: 'Most Liked' });

    expect(router.state.query).toEqual({ collectionId: '2', sort: 'Most Liked' });
    expect(router.state.replaceCalls).toBe(0);
    expect(storedQuery('collection-model-filters')).toEqual({ sort: 'Most Liked' });
  });

  it('forgets a filter the visitor cleared instead of bringing it back', () => {
    open(1, { sort: 'Oldest' });
    act(() => router.navigate({ collectionId: '1' }));
    open(2, {});

    expect(router.state.query).toEqual({ collectionId: '2' });
  });

  it('keeps the remembered value while the address it was applied to is still on its way', () => {
    open(1, { sort: 'Oldest' });
    router.state.defer = true;
    open(2, {});

    expect(router.state.pending?.query).toMatchObject({ sort: 'Oldest' });
    expect(storedQuery('collection-model-filters')).toEqual({ sort: 'Oldest' });
  });

  it('does nothing before the router is ready', () => {
    open(1, { sort: 'Oldest' });
    router.state.isReady = false;
    open(2, {});

    expect(router.state.replaceCalls).toBe(0);
    expect(router.state.query).toEqual({ collectionId: '2' });
  });

  it.each([
    ['posts', { sort: 'Most Comments', period: 'Week' }],
    ['articles', { sort: 'Most Comments', period: 'Week' }],
  ] as const)('brings the sort and period across for %s', (type, remembered) => {
    open(1, remembered, { type });
    open(2, {}, { type });

    expect(router.state.query).toEqual({ collectionId: '2', ...remembered });
  });

  it('seeds only the keys it remembers, even when a stored one would parse', () => {
    localStorage.setItem(
      'collection-model-filters',
      JSON.stringify({ query: { followed: 'true', collectionTagId: '5', sort: 'Oldest' } })
    );

    open(1, {});

    expect(router.state.query).toEqual({ collectionId: '1', sort: 'Oldest' });
  });

  it('still brings the remembered value to a collection that was first seen as a contest', () => {
    open(1, { sort: 'Oldest' });
    open(2, {}, { isContest: true });
    render({ type: 'models', collectionId: 2, isContest: false });

    expect(router.state.query).toEqual({ collectionId: '2', sort: 'Oldest' });
  });

  it('brings the image modifiers the collection filter menu offers', () => {
    const modifiers = {
      nonRemixesOnly: 'true',
      remixesOnly: 'false',
      hideChallenges: 'true',
    };
    open(1, { sort: 'Oldest', ...modifiers }, { type: 'images' });
    open(2, {}, { type: 'images' });

    expect(router.state.query).toEqual({ collectionId: '2', sort: 'Oldest', ...modifiers });
  });

  it('keeps each content type to its own remembered value', () => {
    open(1, { sort: 'Oldest' });
    open(2, {}, { type: 'posts' });

    expect(router.state.query).toEqual({ collectionId: '2' });
  });

  it('never reads or writes for a contest collection', () => {
    open(1, { sort: 'Oldest' });

    open(2, {}, { isContest: true });
    expect(router.state.query).toEqual({ collectionId: '2' });

    open(3, { sort: 'Most Liked' }, { isContest: true });
    expect(storedQuery('collection-model-filters')).toEqual({ sort: 'Oldest' });
  });

  it('never remembers the collection id, its category tag or the followed view', () => {
    open(1, { collectionTagId: '5', followed: 'true', hidden: 'true', sort: 'Oldest' });
    open(2, {});

    expect(router.state.query).toEqual({ collectionId: '2', sort: 'Oldest' });
  });

  it('falls back to the default for a remembered value its schema no longer accepts', () => {
    localStorage.setItem(
      'collection-model-filters',
      JSON.stringify({ query: { sort: 'A Sort That Was Removed', period: 'Week' } })
    );

    open(1, {});

    expect(router.state.query).toEqual({ collectionId: '1', period: 'Week' });
  });
});
