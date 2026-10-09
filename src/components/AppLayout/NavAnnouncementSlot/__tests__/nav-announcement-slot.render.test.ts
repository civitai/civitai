// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ setCookie: vi.fn(), seeded: undefined as string[] | undefined }));
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setCookie: h.setCookie,
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: h.seeded }),
}));

const { useNavBannersDismissed } = await import(
  '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed'
);
const { NavBannerStrip } = await import(
  '~/components/AppLayout/NavAnnouncementSlot/NavAnnouncementSlot'
);

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => act(() => root?.unmount()));
beforeEach(() => {
  h.setCookie.mockClear();
});

function mountHook() {
  const result: { current?: ReturnType<typeof useNavBannersDismissed> } = {};
  function Probe() {
    result.current = useNavBannersDismissed();
    return null;
  }
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => root!.render(React.createElement(Probe)));
  return result;
}

// One file, one store: the zustand store is module scope, so these run in order.
describe('useNavBannersDismissed', () => {
  it("starts from the server's reading of the cookie", () => {
    h.seeded = ['event:old'];
    const hook = mountHook();
    expect(hook.current!.dismissed).toEqual(['event:old']);
    expect(h.setCookie).not.toHaveBeenCalled();
  });

  it('adds to that reading on dismiss and writes a site-wide, long-lived cookie', () => {
    h.seeded = ['event:old'];
    const hook = mountHook();
    const { dismiss } = hook.current!;
    act(() => dismiss('event:new'));
    expect(hook.current!.dismissed).toEqual(['event:old', 'event:new']);
    expect(h.setCookie.mock.calls).toStrictEqual([
      [
        'nav-banners-dismissed',
        '["event:old","event:new"]',
        { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' },
      ],
    ]);
    // The same handler again, a stale render's closure, still keeps the first dismissal.
    act(() => dismiss('event:third'));
    expect(hook.current!.dismissed).toEqual(['event:old', 'event:new', 'event:third']);
  });
});

describe('NavBannerStrip', () => {
  const banner = {
    id: 'event:e1',
    title: 'Hello',
    accent: 'there.',
    href: '/events/e1',
    cta: 'Go',
    dismissible: true,
    priority: 0,
  };

  it('links to the event and offers a dismiss button', () => {
    const html = renderToStaticMarkup(
      React.createElement(NavBannerStrip, { banner, onDismiss: () => undefined })
    );
    expect(html).toContain('href="/events/e1"');
    expect(html).toContain('aria-label="Dismiss Hello"');
  });

  it('offers no dismiss button when the banner is not dismissible', () => {
    const html = renderToStaticMarkup(
      React.createElement(NavBannerStrip, {
        banner: { ...banner, dismissible: false },
        onDismiss: () => undefined,
      })
    );
    expect(html).toContain('href="/events/e1"');
    expect(html).not.toContain('<button');
  });
});
