// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const router = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    isReady: true,
    pathname: '/apps/store',
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
const { useRememberAppsStoreSort } = await import('~/components/Apps/useRememberAppsStoreSort');

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useRememberAppsStoreSort();
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount() {
  act(() => root?.render(React.createElement(FiltersProvider, null, React.createElement(Probe))));
}

const stored = () => JSON.parse(localStorage.getItem('apps-store-filters') ?? '{}').sort;

beforeEach(() => {
  localStorage.clear();
  router.state.replaceCalls = 0;
  router.state.defer = false;
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

describe('useRememberAppsStoreSort', () => {
  it('reopens the store on the sort last chosen when the link into it is bare', () => {
    mount();
    act(() => router.navigate({ sort: 'newest' }));
    act(() => root?.unmount());

    root = createRoot(container as HTMLDivElement);
    router.navigate({});
    mount();

    expect(router.state.query).toEqual({ sort: 'newest' });
  });

  it('lets a sort in the address win, and remembers it', () => {
    router.navigate({ sort: 'name' });
    localStorage.setItem('apps-store-filters', JSON.stringify({ sort: 'newest' }));
    mount();

    expect(router.state.query).toEqual({ sort: 'name' });
    expect(stored()).toBe('name');
  });

  it('remembers Most popular, so choosing it undoes another sort', () => {
    mount();
    act(() => router.navigate({ sort: 'newest' }));
    act(() => router.navigate({}));
    act(() => root?.unmount());

    root = createRoot(container as HTMLDivElement);
    router.navigate({});
    mount();

    expect(router.state.query).toEqual({});
    expect(stored()).toBe('popular');
  });

  it('ignores a remembered sort the store no longer offers', () => {
    localStorage.setItem('apps-store-filters', JSON.stringify({ sort: 'bogus' }));
    mount();

    expect(router.state.query).toEqual({});
  });
});
