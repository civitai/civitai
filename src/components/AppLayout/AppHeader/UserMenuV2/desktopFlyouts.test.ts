// @vitest-environment happy-dom
import { MantineProvider, Menu } from '@mantine/core';
import { IconBox } from '@tabler/icons-react';
import { act, createElement, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as IsMobile from '~/hooks/useIsMobile';
import type { ResolvedMenuNode } from './resolveUserMenu';

/**
 * Hovering from one group row to the next must not leave both flyouts drawn: each group has its own
 * hover timer, and the old one's close timer is longer than the new one's open timer.
 */
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: () => Promise.resolve() }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: forwardRef<HTMLAnchorElement, Record<string, unknown>>(function NextLink(
    { href, as: _as, ...props },
    ref
  ) {
    return createElement('a', { ...props, href: String(href), ref });
  }),
}));
vi.mock('~/components/User/UserBuzz', () => ({ UserBuzz: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => createElement('span', null, 'Avatar'),
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobile>()),
  useIsMobile: () => false,
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Buzz/buzz.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzUtils>()),
  useBuyBuzz: () => vi.fn(),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({ buzz: true }),
}));
vi.mock('~/components/AppLayout/AppHeader/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof HeaderHooks>()),
  useGetCreator: () => null,
}));

const { DesktopNodes } = await import('./UserMenuDesktop');

const child = { id: 'inventory' as const, label: 'Inventory', icon: IconBox, href: '/x' };
const group = (id: string, label: string) =>
  ({
    kind: 'group',
    id,
    label,
    icon: IconBox,
    badge: 0,
    children: [{ kind: 'item', item: child }],
  } as unknown as ResolvedMenuNode);
const nodes = [group('stuff', 'Your stuff'), group('tools', 'Creator tools')];
const pins = { pins: [], canEdit: true, toggle: vi.fn(), move: vi.fn() };

const groupRow = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"][data-menu-item]')].find(
    (el) => el.textContent?.includes(label)
  )!;
const expanded = () =>
  [...document.querySelectorAll('button[aria-haspopup="menu"][data-menu-item]')]
    .filter((el) => el.getAttribute('aria-expanded') === 'true')
    .map((el) => el.textContent);

/** React derives onMouseEnter/onMouseLeave from mouseover/mouseout. */
async function hover(el: HTMLElement, from: HTMLElement | null) {
  await act(async () => {
    from?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: el }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }));
  });
}
let root: Root;
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

beforeEach(async () => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(
          Menu,
          { opened: true, withinPortal: false },
          createElement(Menu.Target, null, createElement('button', null, 'open')),
          createElement(
            Menu.Dropdown,
            null,
            createElement(DesktopNodes, { nodes, pins: pins as never })
          )
        )
      )
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('desktop group flyouts', () => {
  it('shows one flyout at a time when hovering from one group row to the next', async () => {
    const stuff = groupRow('Your stuff');
    const tools = groupRow('Creator tools');

    await hover(stuff, null);
    await wait(100);
    expect(expanded()).toEqual(['Your stuff']);

    await hover(tools, stuff);
    await wait(100);
    expect(expanded()).toEqual(['Creator tools']);

    // The old row's close timer fires about 100ms after the new flyout opened.
    await wait(300);
    expect(expanded()).toEqual(['Creator tools']);
  });

  it('keeps the flyout while the pointer crosses from its row into it, and closes it after leaving', async () => {
    const stuff = groupRow('Your stuff');
    await hover(stuff, null);
    await wait(100);
    const flyout = document.querySelectorAll<HTMLElement>('[data-menu-dropdown]')[1];

    await act(async () => {
      stuff.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: flyout }));
      flyout.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: stuff }));
    });
    await wait(300);
    expect(expanded()).toEqual(['Your stuff']);

    await act(async () => {
      flyout.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })
      );
    });
    await wait(100);
    expect(expanded()).toEqual(['Your stuff']);
    await wait(100);
    expect(expanded()).toEqual([]);
  });
});
