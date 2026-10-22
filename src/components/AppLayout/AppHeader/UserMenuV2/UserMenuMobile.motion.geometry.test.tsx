import { IconBox } from '@tabler/icons-react';
import { act, createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import {
  box,
  nextLayout,
  PHONE_VIEWPORT,
  renderAtViewport,
} from '../../../../../test/geometry-setup';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as TrackUtils from '~/components/TrackView/track.utils';

/**
 * Moving between levels of the phone menu: the panel visibly slides rather than snapping, and a
 * right swipe on a nested level goes back one. Real cascade; the menu tree is a fixed fixture.
 */
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => createElement('span', null, 'avatar'),
}));
vi.mock('~/components/BrowsingMode/BrowsingMode', () => ({
  BrowsingModeMenu: () => createElement('div', null, 'filters'),
}));
vi.mock('~/components/AppLayout/AppHeader/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof HeaderHooks>()),
  useGetCreator: () => undefined,
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Buzz/buzz.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzUtils>()),
  useBuyBuzz: () => vi.fn(),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProvider>()),
  useAppContext: () => ({ seed: 1 }),
  useMaybeAppContext: () => ({ seed: 1 }),
  useServerDomains: () => ({} as never),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  trackAction: () => ({ catch: () => undefined }),
  useTrackEvent: () => ({ trackAction: () => ({ catch: () => undefined }) }),
}));
vi.mock('~/components/CivitaiWrapped/AccountProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAccountContext: () => ({ logout: () => undefined, accounts: [] }),
}));
vi.mock('./useResolvedUserMenu', () => ({
  useResolvedUserMenu: () => ({
    signedIn: true,
    events: [],
    pinned: [],
    nodes: [
      {
        kind: 'group',
        id: 'your-stuff',
        label: 'Your stuff',
        icon: IconBox,
        badge: 0,
        children: [
          {
            kind: 'item',
            item: { id: 'downloads', label: 'Downloads', icon: IconBox, href: '/downloads' },
          },
        ],
      },
    ],
  }),
}));

const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');
const { UserMenuMobile } = await import('./UserMenuMobile');

afterEach(cleanup);

const pins = {
  pins: [],
  canEdit: true,
  toggle: () => undefined,
  move: () => undefined,
  flush: () => undefined,
};

async function renderMenu() {
  await renderAtViewport(
    <ContainerProvider containerName="main">
      <UserMenuMobile
        open
        setOpen={() => undefined}
        pins={pins as never}
        trigger={createElement('button', null, 'menu')}
      />
    </ContainerProvider>,
    PHONE_VIEWPORT
  );
}

/** Clicks and lets React commit before returning, so the slide it starts has barely begun. */
const press = (el: HTMLElement) =>
  act(async () => {
    el.click();
  });
const groupRow = () => document.querySelector<HTMLElement>('[data-group-row="your-stuff"]');
const downloads = () => document.querySelector('a[href="/downloads"]');
const backRow = () =>
  document.querySelector<HTMLElement>('.mantine-Popover-dropdown button[data-panel-row]');
const scrollPanel = (el: Element | null) => el!.closest('.overflow-y-auto')!;
const finishAnimations = (panel: Element) => panel.getAnimations().forEach((a) => a.finish());

/** Freezes the panel's slide at `ms` in, so the pixel position does not depend on frame timing. */
function freezeSlide(panel: Element, ms: number) {
  const slide = panel.getAnimations()[0];
  expect(slide, 'the panel should be animating').toBeDefined();
  slide.pause();
  slide.currentTime = ms;
  return slide;
}

function swipe(target: Element, dx: number, dy: number) {
  const touch = (x: number, y: number) =>
    new Touch({ identifier: 1, target, clientX: x, clientY: y });
  const fire = (type: string, x: number, y: number) =>
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [touch(x, y)],
        changedTouches: [touch(x, y)],
      })
    );
  fire('touchstart', 100, 300);
  fire('touchend', 100 + dx, 300 + dy);
}

describe('phone menu levels', () => {
  test('drilling into a group slides the panel in from the right, over a visible duration', async () => {
    await renderMenu();
    await press(groupRow()!);
    const panel = scrollPanel(downloads());
    const slide = freezeSlide(panel, 50);
    expect(Number(slide.effect!.getTiming().duration)).toBeGreaterThanOrEqual(250);
    // Past the frame where the menu moves focus to the back row: focusing a row that is still off
    // to the right must not scroll the container, or the slide is lost.
    await nextLayout();
    expect(document.activeElement).toBe(backRow());
    const resting = box(panel.parentElement!).left;
    expect(panel.parentElement!.scrollLeft).toBe(0);
    expect(box(panel).left).toBeGreaterThan(resting);
    slide.finish();
    expect(box(panel).left).toBe(resting);
  });

  test('going back slides the panel in from the left, over a visible duration', async () => {
    await renderMenu();
    await press(groupRow()!);
    finishAnimations(scrollPanel(downloads()));
    await press(backRow()!);
    const panel = scrollPanel(groupRow());
    const slide = freezeSlide(panel, 50);
    expect(Number(slide.effect!.getTiming().duration)).toBeGreaterThanOrEqual(250);
    const resting = box(panel.parentElement!).left;
    expect(box(panel).left).toBeLessThan(resting);
    slide.finish();
    expect(box(panel).left).toBe(resting);
  });

  test('a right swipe on a nested level goes back one level', async () => {
    await renderMenu();
    await press(groupRow()!);
    finishAnimations(scrollPanel(downloads()));
    expect(downloads()).not.toBeNull();

    swipe(downloads()!, 150, 10);
    await nextLayout();
    expect(downloads()).toBeNull();
    expect(groupRow()).not.toBeNull();
  });

  test('a right swipe on the top level does not start a slide', async () => {
    await renderMenu();
    swipe(groupRow()!, 150, 10);
    await nextLayout();
    expect(groupRow()).not.toBeNull();
    expect(scrollPanel(groupRow()).getAnimations()).toHaveLength(0);
  });

  test('the top level does not slide in when the account switcher closes after a back', async () => {
    await renderMenu();
    await press(groupRow()!);
    finishAnimations(scrollPanel(downloads()));
    await press(backRow()!);
    finishAnimations(scrollPanel(groupRow()));

    await press(document.querySelector<HTMLElement>('[aria-label="Switch account"]')!);
    expect(groupRow()).toBeNull();
    const menu = document.querySelector('.mantine-Popover-dropdown')!.firstElementChild!;
    await act(async () => {
      menu.firstElementChild!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(groupRow()).not.toBeNull();
    expect(scrollPanel(groupRow()).getAnimations()).toHaveLength(0);
  });
});
