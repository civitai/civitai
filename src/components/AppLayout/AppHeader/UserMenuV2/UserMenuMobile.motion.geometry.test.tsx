import { IconBox } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { box, PHONE_VIEWPORT, renderAtViewport } from '../../../../../test/geometry-setup';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as TrackUtils from '~/components/TrackView/track.utils';

/**
 * Moving between levels of the phone menu: the panel visibly slides rather than snapping, and a
 * right swipe on a nested level goes back one. Real cascade; the menu tree is a fixed fixture.
 */
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProvider>()),
  useAppContext: () => ({ seed: 1 }),
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

const groupRow = () => document.querySelector<HTMLElement>('[data-group-row="your-stuff"]');
const downloads = () => document.querySelector('a[href="/downloads"]');
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settled = async () => {
  for (const el of document.querySelectorAll('.mantine-Popover-dropdown *'))
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await frame();
};

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
  test('drilling into a group slides the panel in over a visible duration', async () => {
    await renderMenu();
    groupRow()!.click();
    await frame();
    await frame();
    const panel = downloads()!.closest('.overflow-y-auto')!;
    const slide = panel.getAnimations()[0];
    expect(slide, 'the panel should be animating').toBeDefined();
    expect(Number(slide.effect!.getTiming().duration)).toBeGreaterThanOrEqual(250);
    // Mid-slide the panel is still off to the right of its resting place.
    expect(box(panel).left).toBeGreaterThan(0);
    await settled();
    expect(box(panel).left).toBe(box(panel.parentElement!).left);
  });

  test('a right swipe goes back one level; a vertical or leftward one does not', async () => {
    await renderMenu();
    groupRow()!.click();
    await settled();
    expect(downloads()).not.toBeNull();

    swipe(downloads()!, 20, 150);
    swipe(downloads()!, -150, 5);
    await settled();
    expect(downloads()).not.toBeNull();

    swipe(downloads()!, 150, 10);
    await settled();
    expect(downloads()).toBeNull();
    expect(groupRow()).not.toBeNull();
  });

  test('a right swipe on the top level changes nothing', async () => {
    await renderMenu();
    swipe(groupRow()!, 150, 10);
    await settled();
    expect(groupRow()).not.toBeNull();
  });
});
