// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import type * as Trpc from '~/utils/trpc';
import type * as Notifications from '~/utils/notifications';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `banners` stands in for the gated server answer this viewer was seeded with.
const h = vi.hoisted(() => ({
  banners: [] as NavBanner[],
  showInfoNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({ 'event.getNavBanners': { useQuery: () => ({ data: h.banners }) } }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showInfoNotification: h.showInfoNotification,
}));
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setCookie: vi.fn(),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: [] }),
}));
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({ EdgeImage: () => null }));

const { useEventMenuItems, useMarkEventVisited } = await import(
  '~/components/AppLayout/AppHeader/useEventMenuItems'
);
const { TeamRostersButton } = await import('~/components/Cosmetics/EventDecoration/WornHatPopover');
const { EventNavBanners } = await import(
  '~/components/AppLayout/NavAnnouncementSlot/NavAnnouncementSlot'
);

const BIRTHDAY: NavBanner = {
  id: 'event:birthday2026',
  title: 'Civitai turns 4.',
  href: '/events/birthday2026',
  dismissible: true,
  priority: 0,
  promo: {
    event: 'birthday2026',
    menuLabel: "Civitai's 4th Birthday",
    menuIcon: 'confetti',
    teamHref: '/events/birthday2026/team',
  },
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
beforeEach(() => {
  h.banners = [];
  h.showInfoNotification.mockClear();
  localStorage.clear();
});

function render(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, node)));
  return host;
}

function mountMenuItems(visiting?: string) {
  const result: { current: ReturnType<typeof useEventMenuItems> } = { current: [] };
  function Probe() {
    result.current = useEventMenuItems();
    return null;
  }
  function Visit({ event }: { event: string }) {
    useMarkEventVisited(event);
    return null;
  }
  render(
    React.createElement(
      React.Fragment,
      null,
      visiting && React.createElement(Visit, { event: visiting }),
      React.createElement(Probe)
    )
  );
  return result;
}

describe('user-menu event entry', () => {
  it('is absent when the gated answer has no promo for this viewer', () => {
    expect(mountMenuItems().current).toEqual([]);
    act(() => root?.unmount());
    h.banners = [{ ...BIRTHDAY, promo: undefined }];
    expect(mountMenuItems().current).toEqual([]);
  });

  it('links a playable event, NEW until its page is visited', () => {
    h.banners = [BIRTHDAY];
    expect(mountMenuItems().current.map((i) => [i.label, i.href, i.isNew])).toEqual([
      ["Civitai's 4th Birthday", '/events/birthday2026', true],
    ]);
    act(() => root?.unmount());
    expect(mountMenuItems('birthday2026').current[0].isNew).toBe(false);
    act(() => root?.unmount());
    // Remembered on the next page, where nothing marks it.
    expect(mountMenuItems().current[0].isNew).toBe(false);
  });

  it("stays NEW after another event's page is visited", () => {
    h.banners = [BIRTHDAY];
    expect(mountMenuItems('other').current[0].isNew).toBe(true);
  });
});

describe('worn-hat popover Team rosters button', () => {
  const button = () =>
    render(React.createElement(TeamRostersButton, { event: 'birthday2026', onClick: vi.fn() }));

  it('is absent when the gated answer has no promo for this viewer', () => {
    expect(button().querySelector('a')).toBeNull();
  });

  it("links the event's roster for a viewer who can play it", () => {
    h.banners = [BIRTHDAY];
    const link = button().querySelector('a');
    expect([link?.getAttribute('href'), link?.textContent]).toEqual([
      '/events/birthday2026/team',
      'Team rosters',
    ]);
  });
});

describe('dismissing the strip', () => {
  const dismiss = () => {
    const el = render(React.createElement(EventNavBanners));
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')!.click());
  };

  it('says where the event went', () => {
    h.banners = [BIRTHDAY];
    dismiss();
    expect(h.showInfoNotification.mock.calls).toEqual([
      [
        expect.objectContaining({
          message: "Find Civitai's 4th Birthday in your menu any time.",
        }),
      ],
    ]);
  });

  it('says nothing for a strip whose event has no menu entry', () => {
    // Another id: the dismissed-strip store is module scope, so the first case's dismissal holds.
    h.banners = [{ ...BIRTHDAY, id: 'event:other', promo: undefined }];
    dismiss();
    expect(h.showInfoNotification).not.toHaveBeenCalled();
  });
});
