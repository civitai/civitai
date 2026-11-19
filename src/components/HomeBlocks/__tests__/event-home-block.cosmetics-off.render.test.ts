// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// With event cosmetics off, a scored event's home block (Hat Turf's) is gone, wrapper and all, and
// the event page keeps its counters. Event cosmetics on, the block shows as before.

const { act } = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ cosmetics: true }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getData': { useQuery: () => ({ data: { scored: true } }) },
  }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useShowEventCosmetics: () => h.cosmetics,
}));
vi.mock('~/components/HomeBlocks/ScoredEventHomeBlock', () => ({
  ScoredEventHomeBlock: () => React.createElement('div', { 'data-testid': 'scored-block' }),
}));
vi.mock('~/components/HomeBlocks/HomeBlockWrapper', () => ({
  HomeBlockWrapper: ({ children }: { children: React.ReactNode }) =>
    React.createElement('section', { 'data-testid': 'wrapper' }, children),
}));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: () => undefined, inView: true }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: [] }),
}));

const { EventHomeBlock } = await import('~/components/HomeBlocks/EventHomeBlock');

let root: ReturnType<typeof createRoot> | undefined;
let el: HTMLDivElement;
beforeEach(() => {
  h.cosmetics = true;
});
afterEach(() => act(() => root?.unmount()));

function mount() {
  el = document.createElement('div');
  root = createRoot(el);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(EventHomeBlock, { metadata: { event: 'birthday2026' } })
      )
    )
  );
}
const has = (id: string) => !!el.querySelector(`[data-testid="${id}"]`);

describe('EventHomeBlock with event cosmetics off', () => {
  it('renders nothing for a scored event, not even the wrapper', () => {
    h.cosmetics = false;
    mount();
    expect(has('scored-block')).toBe(false);
    expect(has('wrapper')).toBe(false);
  });

  // Control: the same event with cosmetics on shows the block.
  it('shows the scored block with event cosmetics on', () => {
    mount();
    expect(has('scored-block')).toBe(true);
  });
});
