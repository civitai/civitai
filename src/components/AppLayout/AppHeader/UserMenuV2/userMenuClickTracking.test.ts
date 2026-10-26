// @vitest-environment happy-dom
import { MantineProvider, Menu } from '@mantine/core';
import { IconBox } from '@tabler/icons-react';
import { act, createElement, forwardRef } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackActionInput } from '~/server/schema/track.schema';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as IsMobile from '~/hooks/useIsMobile';

/**
 * `UserMenu_Click` decides the default pins, so a row must record exactly one open per real
 * activation and none for the controls that share it: the pin toggle, and the click a drag drop
 * produces. Each case drives the real row component; only the transport and the session are stubbed.
 */
const mocks = vi.hoisted(() => ({
  actions: [] as TrackActionInput[],
  user: { id: 1, username: 'tester' } as { id: number; username: string } | null,
  flags: { buzz: true } as Record<string, boolean>,
}));

vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({
    trackAction: (data: TrackActionInput) => {
      mocks.actions.push(data);
      return Promise.resolve();
    },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
// next/link needs a router to navigate; the row's own click handler is what is under test.
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: forwardRef<HTMLAnchorElement, Record<string, unknown>>(function NextLink(
    { href, as: _as, ...props },
    ref
  ) {
    return createElement('a', { ...props, href: String(href), ref });
  }),
}));

// The header rows' balances, avatar and Buy Buzz modal are not what is under test.
const buyBuzz = vi.hoisted(() => vi.fn());
vi.mock('~/components/User/UserBuzz', () => ({ UserBuzz: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => createElement('span', null, 'Avatar'),
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobile>()),
  useIsMobile: () => true,
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProvider>()),
  useAppContext: () => ({ seed: 1 }),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Buzz/buzz.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzUtils>()),
  useBuyBuzz: () => buyBuzz,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => mocks.flags,
}));
vi.mock('~/components/AppLayout/AppHeader/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof HeaderHooks>()),
  useGetCreator: () => null,
}));

const { DesktopHeaderRows, DesktopItem, PinnedList } = await import('./UserMenuDesktop');
const { MobileHeaderRows, MobileItem, MobilePinned } = await import('./UserMenuMobile');
const { BadgeMuteCtx, useDragClickGuard } = await import('./UserMenuParts');
const { BuzzMenuItem, UserMenuCtx } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { trackActionInputSchema } = await import('~/server/schema/track.schema');

const inventory = { id: 'inventory' as const, label: 'Inventory', icon: IconBox, href: '/x' };
const civitaiLink = { id: 'civitai-link' as const, label: 'Link', icon: IconBox, onClick: vi.fn() };

let container: HTMLDivElement;
const handleClose = vi.fn();

async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(UserMenuCtx.Provider, { value: { handleClose } }, node)
      )
    );
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  // A cancelable click, so a guard's preventDefault stops happy-dom following the link.
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Mantine renders the dropdown in a portal on `document.body`, outside the container. */
const row = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('a, button')].find(
    (el) => el.textContent?.includes(label) && !el.getAttribute('aria-label')
  );

const inMenu = (node: ReactNode) =>
  createElement(
    Menu,
    { opened: true, withinPortal: false },
    createElement(Menu.Target, null, createElement('button', null, 'open')),
    createElement(Menu.Dropdown, null, node)
  );
const desktop = (props: Record<string, unknown>) =>
  inMenu(createElement(DesktopItem, props as never));

const pins = { pins: ['inventory'], canEdit: true, toggle: vi.fn(), move: vi.fn() };
const details = () => mocks.actions.map((a) => a.type === 'UserMenu_Click' && a.details);

// Bubble phase on window, so after React: stops happy-dom following a link onto the network.
const noNavigate = (event: MouseEvent) => event.preventDefault();

beforeEach(() => {
  window.addEventListener('click', noNavigate);
  mocks.actions = [];
  mocks.user = { id: 1, username: 'tester' };
  mocks.flags = { buzz: true };
  handleClose.mockClear();
  buyBuzz.mockClear();
  civitaiLink.onClick.mockClear();
});
afterEach(() => {
  window.removeEventListener('click', noNavigate);
  document.body.innerHTML = '';
});

describe('UserMenu_Click', () => {
  it('records one open per row click on mobile, with the home group and surface', async () => {
    await mount(createElement(MobileItem, { item: inventory, onToggle: vi.fn() }));
    await click(row('Inventory'));

    expect(mocks.actions).toEqual([
      {
        type: 'UserMenu_Click',
        details: { item: 'inventory', group: 'your-stuff', pinned: false, surface: 'mobile' },
      },
    ]);
    // A row's own handler is replaced, so it must still close the menu.
    expect(handleClose).toHaveBeenCalledTimes(1);
    // The server drops what its schema rejects with a 200, so the row has to be one it accepts.
    expect(trackActionInputSchema.safeParse(mocks.actions[0]).success).toBe(true);
  });

  it('records a pinned-section open as pinned, keeping the home group', async () => {
    await mount(createElement(MobileItem, { item: inventory, pinned: true, fromPins: true }));
    await click(row('Inventory'));
    expect(mocks.actions.map((a) => a.type === 'UserMenu_Click' && a.details)).toEqual([
      { item: 'inventory', group: 'your-stuff', pinned: true, surface: 'mobile' },
    ]);
  });

  it('records an action item and still runs its action', async () => {
    await mount(createElement(MobileItem, { item: civitaiLink }));
    await click(row('Link'));
    expect(civitaiLink.onClick).toHaveBeenCalledTimes(1);
    expect(mocks.actions.map((a) => a.type === 'UserMenu_Click' && a.details)).toEqual([
      { item: 'civitai-link', group: 'creator-tools', pinned: false, surface: 'mobile' },
    ]);
  });

  it('records a phone Create row under the create group', async () => {
    await mount(
      createElement(MobileItem, {
        item: { id: 'create-generate', label: 'Generate', icon: IconBox, href: '/generate' },
      })
    );
    await click(row('Generate'));
    expect(details()).toEqual([
      { item: 'create-generate', group: 'create', pinned: false, surface: 'mobile' },
    ]);
  });

  it('does not record the mobile pin toggle', async () => {
    const onToggle = vi.fn();
    await mount(createElement(MobileItem, { item: inventory, onToggle }));
    await click(document.querySelector('[aria-label="Pin Inventory"]'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(mocks.actions).toEqual([]);
  });

  it('records one open per row click on desktop', async () => {
    await mount(desktop({ item: inventory, onToggle: vi.fn() }));
    await click(row('Inventory'));
    expect(mocks.actions.map((a) => a.type === 'UserMenu_Click' && a.details)).toEqual([
      { item: 'inventory', group: 'your-stuff', pinned: false, surface: 'desktop' },
    ]);
  });

  it('does not record the desktop pin toggle', async () => {
    const onToggle = vi.fn();
    await mount(desktop({ item: inventory, onToggle }));
    await click(document.querySelector('[title="Pin"]'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(mocks.actions).toEqual([]);
  });

  describe('muting a count', () => {
    const waiting = { ...inventory, badge: 3 };
    const withMute = (toggleMute: () => void, node: ReactNode) =>
      createElement(BadgeMuteCtx.Provider, { value: toggleMute }, node);

    it.each([
      [
        'mobile',
        '[aria-label="Mute the count on Inventory"]',
        (item: object) => createElement(MobileItem, { item: item as never, onToggle: vi.fn() }),
      ],
      ['desktop', '[title="Mute count"]', (item: object) => desktop({ item, onToggle: vi.fn() })],
    ])('mutes the %s count without opening or recording the row', async (_s, selector, node) => {
      const toggleMute = vi.fn();
      await mount(withMute(toggleMute, node(waiting)));
      await click(document.querySelector(selector));

      expect(toggleMute).toHaveBeenCalledTimes(1);
      expect(mocks.actions).toEqual([]);
      expect(handleClose).not.toHaveBeenCalled();
    });

    it('shows a muted count as a pressed mute button that can be pressed again', async () => {
      const toggleMute = vi.fn();
      await mount(
        withMute(toggleMute, createElement(MobileItem, { item: { ...waiting, badgeMuted: true } }))
      );
      const button = document.querySelector('[aria-label="Mute the count on Inventory"]');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      await click(button);
      expect(toggleMute).toHaveBeenCalledTimes(1);
    });

    it('mutes from the keyboard on desktop with M', async () => {
      const toggleMute = vi.fn();
      await mount(withMute(toggleMute, desktop({ item: waiting, onToggle: vi.fn() })));
      await act(async () => {
        row('Inventory')!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true })
        );
      });
      expect(toggleMute).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['has no count waiting', { provided: true, item: inventory }],
      ['is not a count that can be muted', { provided: true, item: { ...civitaiLink, badge: 2 } }],
      ['is shown where counts cannot be muted', { provided: false, item: waiting }],
    ])('offers no mute on a %s row (phone and desktop)', async (_why, { provided, item }) => {
      const toggleMute = vi.fn();
      const phone = createElement(MobileItem, { item: item as never, onToggle: vi.fn() });
      await mount(provided ? withMute(toggleMute, phone) : phone);
      expect(document.querySelector('[aria-label*="the count on"]')).toBeNull();
      document.body.innerHTML = '';

      await mount(
        provided
          ? withMute(toggleMute, desktop({ item, onToggle: vi.fn() }))
          : desktop({ item, onToggle: vi.fn() })
      );
      expect(document.querySelector('[title$="count"]')).toBeNull();
      await act(async () => {
        row(item.label)!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true })
        );
      });
      expect(toggleMute).not.toHaveBeenCalled();
    });

    it('does not mute on Ctrl+M or Cmd+M', async () => {
      const toggleMute = vi.fn();
      await mount(withMute(toggleMute, desktop({ item: waiting, onToggle: vi.fn() })));
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        await act(async () => {
          row('Inventory')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true, ...modifier })
          );
        });
      }
      expect(toggleMute).not.toHaveBeenCalled();
    });
  });

  // The two Pinned lists are where `pinned: true` comes from, so they are rendered for real.
  it('records an open from the desktop Pinned list as pinned', async () => {
    await mount(
      inMenu(
        createElement(PinnedList, {
          pinned: [inventory],
          pins,
          onToggle: vi.fn(),
          announce: vi.fn(),
        } as never)
      )
    );
    await click(row('Inventory'));
    expect(details()).toEqual([
      { item: 'inventory', group: 'your-stuff', pinned: true, surface: 'desktop' },
    ]);
  });

  it('records an open from the mobile Pinned list as pinned', async () => {
    await mount(
      createElement(MobilePinned, {
        pinned: [inventory],
        pins,
        onToggle: vi.fn(),
        announce: vi.fn(),
      } as never)
    );
    await click(row('Inventory'));
    expect(details()).toEqual([
      { item: 'inventory', group: 'your-stuff', pinned: true, surface: 'mobile' },
    ]);
  });

  it('records an external link on mobile and closes the menu', async () => {
    const faq = {
      id: 'support-faq' as const,
      label: 'FAQ',
      icon: IconBox,
      href: 'https://x.test',
      external: true,
    };
    await mount(createElement(MobileItem, { item: faq }));
    await click(row('FAQ'));
    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(details()).toEqual([
      { item: 'support-faq', group: 'help', pinned: false, surface: 'mobile' },
    ]);
  });

  // The avatar row links to the profile and the Buzz row to the dashboard, so opens there sit beside
  // opens of the `profile` and `buzz-dashboard` pins: that is what settles whether those pins earn
  // their place.
  it.each([
    // Desktop rows are Mantine Menu.Items, which close the menu themselves.
    ['desktop', () => inMenu(createElement(DesktopHeaderRows)), 0, 'Buy Buzz'],
    // The phone sheet closes before the purchase opens.
    ['mobile', () => createElement(MobileHeaderRows), 3, 'Buy Buzz'],
  ] as const)(
    'records the %s header rows as header opens, and not Buy Buzz',
    async (surface, node, closes, buyLabel) => {
      await mount(node());
      await click(row('Avatar'));
      await click(document.querySelector('a[href="/user/buzz-dashboard"]'));
      await click(
        [...document.querySelectorAll('.mantine-Button-root')].find(
          (el) => el.textContent === buyLabel
        )
      );

      expect(buyBuzz).toHaveBeenCalledTimes(1);
      expect(handleClose).toHaveBeenCalledTimes(closes);
      expect(details()).toEqual([
        { item: 'profile', group: 'header', pinned: false, surface },
        { item: 'buzz-dashboard', group: 'header', pinned: false, surface },
      ]);
      expect(trackActionInputSchema.safeParse(mocks.actions[1]).success).toBe(true);
    }
  );

  // The profile row is in no group, so its own pin toggle is the only way to pin it again.
  it.each([
    [
      'desktop',
      (onTogglePin: () => void) => inMenu(createElement(DesktopHeaderRows, { onTogglePin })),
      '[title="Pin"]',
      true,
    ],
    [
      'mobile',
      (onTogglePin: () => void) => createElement(MobileHeaderRows, { onTogglePin }),
      '[aria-label="Pin Your Profile"]',
      false,
    ],
  ] as const)(
    'toggles the %s profile pin without opening or recording the profile',
    async (_surface, node, toggleSelector, insideLink) => {
      const onTogglePin = vi.fn();
      const preventDefault = vi.spyOn(Event.prototype, 'preventDefault');
      await mount(node(onTogglePin));
      await click(document.querySelector(toggleSelector));

      expect(onTogglePin).toHaveBeenCalledTimes(1);
      expect(mocks.actions).toEqual([]);
      expect(handleClose).not.toHaveBeenCalled();
      // Desktop only: the toggle sits inside the profile link, and `stopPropagation` keeps the click from
      // reaching `noNavigate`, so this call is the toggle's own.
      if (insideLink) expect(preventDefault).toHaveBeenCalled();
      preventDefault.mockRestore();
    }
  );

  it('keeps the Pro chip out of the mobile header rows, whatever the flags', async () => {
    mocks.flags = { buzz: true, buzzSpendPop: true, canWrite: true };
    await mount(createElement(MobileHeaderRows));

    expect(document.querySelector('a[href="/purchase/buzz"], a[href*="/pricing"]')).toBeNull();
    expect(document.querySelector('a[href="/user/buzz-dashboard"]')).not.toBeNull();
  });

  // The legacy menu renders the shared Buzz row with no `onOpen`, for every viewer without the flag.
  it('closes the legacy Buzz row without onOpen, and records nothing', async () => {
    await mount(createElement(BuzzMenuItem));
    await click(document.querySelector('a[href="/user/buzz-dashboard"]'));

    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(mocks.actions).toEqual([]);
  });

  it('gives a signed-out top-level item no group', async () => {
    mocks.user = null;
    const leaderboard = { id: 'leaderboard' as const, label: 'Leaders', icon: IconBox, href: '/l' };
    await mount(createElement(MobileItem, { item: leaderboard }));
    await click(row('Leaders'));
    expect(mocks.actions.map((a) => a.type === 'UserMenu_Click' && a.details)).toEqual([
      { item: 'leaderboard', group: null, pinned: false, surface: 'mobile' },
    ]);
  });

  it('does not record the click a drag drop produces, and records the next one', async () => {
    let guard: ReturnType<typeof useDragClickGuard> | undefined;
    const Harness = () => {
      guard = useDragClickGuard();
      return createElement(MobileItem, { item: inventory, pinned: true, fromPins: true });
    };
    await mount(createElement(Harness));

    guard!.onDragStart();
    guard!.onDragSettled();
    await click(row('Inventory'));
    expect(mocks.actions).toEqual([]);

    // The guard clears on the next task, after the drop's click.
    await act(() => new Promise((resolve) => setTimeout(resolve)));
    await click(row('Inventory'));
    expect(mocks.actions).toHaveLength(1);
  });
});
