// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ dismissed: [] as string[] }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getData': { useQuery: () => ({ data: { scored: true } }) },
  }),
}));
// The block's own content is covered in scored-event-home-block.render.test.ts; which state the
// home page row lands in is what is measured here.
vi.mock('~/components/HomeBlocks/ScoredEventHomeBlock', () => ({
  ScoredEventHomeBlock: ({ collapsed }: { collapsed: boolean }) =>
    React.createElement('div', { 'data-testid': collapsed ? 'home-bar' : 'home-full' }),
}));
vi.mock('~/components/HomeBlocks/HomeBlockWrapper', () => ({
  HomeBlockWrapper: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: () => undefined, inView: true }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: h.dismissed }),
}));
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setCookie: vi.fn(),
}));

const { setCookie } = await import('cookies-next');
const { ShowEventHomeBlock } = await import('~/components/HomeBlocks/ShowEventHomeBlock');
const { EventHomeBlock } = await import('~/components/HomeBlocks/EventHomeBlock');
const { useNavBannersDismissed } = await import(
  '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed'
);

const HIDE = 'home:event:birthday2026';
const COLLAPSE = 'home:event:birthday2026:collapsed';

let root: ReturnType<typeof createRoot> | undefined;
let hook: ReturnType<typeof useNavBannersDismissed> | undefined;
beforeEach(() => {
  h.dismissed = [];
  vi.mocked(setCookie).mockClear();
});
afterEach(() => act(() => root?.unmount()));

// The event page's action beside the home page's row, sharing one dismiss store as they do in a tab.
function mount() {
  function Probe() {
    hook = useNavBannersDismissed();
    return null;
  }
  const el = document.createElement('div');
  root = createRoot(el);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(Probe),
        React.createElement(ShowEventHomeBlock, {
          event: 'birthday2026',
          title: "Civitai's 4th Birthday",
        }),
        React.createElement(EventHomeBlock, { metadata: { event: 'birthday2026' } })
      )
    )
  );
  return el;
}
const action = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('[data-testid="show-event-home-block"]');
const homeState = (el: HTMLElement) =>
  el.querySelector('[data-testid^="home-"]')?.getAttribute('data-testid') ?? 'none';
const saved = () => JSON.parse(vi.mocked(setCookie).mock.calls.at(-1)![1] as string);

describe('ShowEventHomeBlock', () => {
  it('is offered only while the block is hidden, not while it is full or collapsed', () => {
    let el = mount();
    expect(action(el)).toBeNull();
    expect(homeState(el)).toBe('home-full');
    act(() => root?.unmount());

    h.dismissed = [COLLAPSE];
    el = mount();
    expect(action(el)).toBeNull();
    expect(homeState(el)).toBe('home-bar');
    act(() => root?.unmount());

    h.dismissed = ['home:event:other:collapsed', 'home:event:other'];
    el = mount();
    expect(action(el)).toBeNull();
    act(() => root?.unmount());

    h.dismissed = [HIDE];
    el = mount();
    expect(action(el)?.textContent).toBe("Show Civitai's 4th Birthday on my home page");
    expect(homeState(el)).toBe('none');
    expect(setCookie).not.toHaveBeenCalled();
  });

  // Must stay last: the dismissed store it writes is module scope.
  it('brings the full block back for a viewer who hid it before this action existed', () => {
    // What the bar's close has written since the block shipped: the hide replaces the collapse.
    h.dismissed = ['event:birthday2026', 'home:event:other', HIDE];
    const el = mount();
    expect(homeState(el)).toBe('none');
    act(() => action(el)!.click());
    expect(homeState(el)).toBe('home-full');
    expect(action(el)).toBeNull();
    expect(saved()).toEqual(['event:birthday2026', 'home:event:other']);
    expect(vi.mocked(setCookie).mock.calls.at(-1)![0]).toBe('nav-banners-dismissed');

    // A cookie holding both entries comes back full, not collapsed.
    act(() => hook!.dismiss(COLLAPSE));
    act(() => hook!.dismiss(HIDE));
    expect(homeState(el)).toBe('none');
    act(() => action(el)!.click());
    expect(homeState(el)).toBe('home-full');
    expect(saved()).toEqual(['event:birthday2026', 'home:event:other']);
  });
});
