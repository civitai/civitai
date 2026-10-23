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
import { SWIPE_COMMIT_FRACTION, SWIPE_FLICK_MIN_PX } from './swipeBack';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as TrackUtils from '~/components/TrackView/track.utils';

/**
 * Moving between levels of the phone menu: the panel visibly slides rather than snapping, and a
 * right drag on a nested level follows the finger over the level behind and goes back one, or snaps
 * back. Real cascade; the menu tree is a fixed fixture; touches are dispatched by hand, so a real
 * finger's scroll arbitration is not covered.
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

const START = { x: 100, y: 300 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A pause by the clock, so a flick's gap does not depend on when the timer gets to run. */
const spin = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};
const FLICK_PX = 60;

/** A finger on `target`: `to` moves it by (dx, dy) from where it touched down, `lift` lets go there. */
function finger(target: Element) {
  const fire = (type: string, dx: number, dy: number) => {
    const point = new Touch({
      identifier: 1,
      target,
      clientX: START.x + dx,
      clientY: START.y + dy,
    });
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [point],
        changedTouches: [point],
      })
    );
  };
  fire('touchstart', 0, 0);
  return {
    to: (dx: number, dy = 0) => fire('touchmove', dx, dy),
    lift: (dx: number, dy = 0) => fire('touchend', dx, dy),
  };
}

const behindLayer = () => document.querySelector<HTMLElement>('[inert]');
const panelLeft = (panel: Element) => box(panel).left;

describe('dragging a nested level back', () => {
  async function renderNested() {
    await renderMenu();
    await press(groupRow()!);
    finishAnimations(scrollPanel(downloads()));
    const panel = scrollPanel(downloads());
    return { panel, resting: panelLeft(panel) };
  }

  test('the panel follows the finger over the level it goes back to, which then lands in place', async () => {
    const { panel, resting } = await renderNested();
    expect(behindLayer()).toBeNull();

    const touch = finger(downloads()!);
    touch.to(40);
    touch.to(80);
    await nextLayout();
    expect(panelLeft(panel)).toBeCloseTo(resting + 80, 0);
    // The level behind is on screen, a step to the left of where it will rest.
    const behind = behindLayer();
    expect(behind, 'the level behind').not.toBeNull();
    expect(behind!.contains(groupRow())).toBe(true);
    const behindEarly = panelLeft(behind!);
    expect(behindEarly).toBeLessThan(resting);

    touch.to(220);
    await nextLayout();
    expect(panelLeft(panel)).toBeCloseTo(resting + 220, 0);
    // It trails the finger: further along, the level behind has come closer to where it rests.
    expect(panelLeft(behind!)).toBeGreaterThan(behindEarly);

    // Rest the finger first: this goes back on the distance dragged, not on a flick.
    await sleep(160);
    touch.lift(220);
    // Settling takes a visible time: the panel is still there, on its way off.
    expect(downloads()).not.toBeNull();
    expect(panel.style.transition).toContain('transform');
    // It goes off to the right, a full panel width from where it rests.
    expect(panel.style.transform).toBe(`translateX(${box(panel).width}px)`);
    await vi.waitFor(() => expect(downloads()).toBeNull());
    expect(behindLayer()).toBeNull();
    const landed = scrollPanel(groupRow());
    expect(panelLeft(landed)).toBe(resting);
    // Not a slide in from the left on top of a level that was already showing.
    expect(landed.getAnimations()).toHaveLength(0);
  });

  test('letting go early snaps back to the nested level', async () => {
    const { panel, resting } = await renderNested();
    const touch = finger(downloads()!);
    touch.to(30);
    touch.to(70);
    await nextLayout();
    expect(panelLeft(panel)).toBeCloseTo(resting + 70, 0);
    // Rest the finger so the release carries no flick.
    await sleep(160);
    touch.lift(70);

    await vi.waitFor(() => expect(behindLayer()).toBeNull());
    expect(downloads()).not.toBeNull();
    expect(panelLeft(scrollPanel(downloads()))).toBe(resting);
    expect(scrollPanel(downloads()).style.transform).toBe('');
    expect(scrollPanel(downloads()).style.transition).toBe('');

    // And the panel is free to be dragged again.
    const again = finger(downloads()!);
    again.to(40);
    again.to(80);
    await nextLayout();
    expect(behindLayer()).not.toBeNull();
    again.to(0);
    again.lift(0);
    await vi.waitFor(() => expect(behindLayer()).toBeNull());
  });

  test('a quick flick goes back from a short distance', async () => {
    const { panel } = await renderNested();
    // Past a flick's distance, well short of the commit distance, and let go at speed.
    expect(FLICK_PX).toBeGreaterThanOrEqual(SWIPE_FLICK_MIN_PX);
    expect(FLICK_PX).toBeLessThan(box(panel).width * SWIPE_COMMIT_FRACTION);
    const touch = finger(downloads()!);
    touch.to(FLICK_PX / 2);
    spin(8);
    touch.to(FLICK_PX);
    touch.lift(FLICK_PX);
    await vi.waitFor(() => expect(downloads()).toBeNull());
    expect(groupRow()).not.toBeNull();
  });

  test('a drag begun while the panel is still sliding in does not start', async () => {
    await renderMenu();
    await press(groupRow()!);
    const panel = scrollPanel(downloads());
    expect(panel.getAnimations().length, 'the slide-in should be running').toBeGreaterThan(0);
    const touch = finger(downloads()!);
    touch.to(40);
    touch.to(120);
    await nextLayout();
    expect(behindLayer()).toBeNull();
    touch.lift(120);
  });

  test('a mostly vertical drag is left to scroll, and a leftward one is ignored', async () => {
    const { panel, resting } = await renderNested();
    for (const [dx, dy] of [
      [6, 70],
      [-60, 4],
    ]) {
      const touch = finger(downloads()!);
      touch.to(dx / 2, dy / 2);
      touch.to(dx, dy);
      await nextLayout();
      expect(panelLeft(panel)).toBe(resting);
      expect(behindLayer()).toBeNull();
      touch.lift(dx, dy);
      await nextLayout();
      expect(downloads()).not.toBeNull();
    }
  });

  // A real second finger sends a touchstart with two touches; a touchmove with two is the fallback.
  test.each(['touchstart', 'touchmove'])(
    'a second finger (%s) cancels the drag back to the nested level',
    async (type) => {
      const { panel, resting } = await renderNested();
      const target = downloads()!;
      const touch = finger(target);
      touch.to(40);
      touch.to(90);
      await nextLayout();
      expect(panelLeft(panel)).toBeGreaterThan(resting + 80);

      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: [0, 1].map(
            (i) => new Touch({ identifier: i, target, clientX: 100 + i * 50, clientY: 300 })
          ),
          changedTouches: [new Touch({ identifier: 1, target, clientX: 150, clientY: 300 })],
        })
      );
      await vi.waitFor(() => expect(behindLayer()).toBeNull());
      expect(downloads()).not.toBeNull();
      expect(panelLeft(scrollPanel(downloads()))).toBe(resting);
    }
  );

  test('a cancelled touch snaps the panel back', async () => {
    const { panel, resting } = await renderNested();
    const target = downloads()!;
    const touch = finger(target);
    touch.to(40);
    touch.to(90);
    await nextLayout();
    expect(panelLeft(panel)).toBeGreaterThan(resting + 80);

    target.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(behindLayer()).toBeNull());
    expect(downloads()).not.toBeNull();
    expect(panelLeft(scrollPanel(downloads()))).toBe(resting);
  });

  test('under reduced motion the panel still follows the finger but settles without a slide', async () => {
    const real = window.matchMedia.bind(window);
    const reduced = (query: string) =>
      ({
        matches: true,
        media: query,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as MediaQueryList);
    const spy = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation((query) =>
        query.includes('prefers-reduced-motion') ? reduced(query) : real(query)
      );
    try {
      const { panel, resting } = await renderNested();
      const touch = finger(downloads()!);
      touch.to(40);
      touch.to(200);
      await nextLayout();
      expect(panelLeft(panel)).toBeCloseTo(resting + 200, 0);

      // No transition is set, so going back lands on the next frame instead of after a slide.
      touch.lift(200);
      expect(panel.style.transition).toBe('');
      await nextLayout();
      expect(downloads()).toBeNull();
      expect(groupRow()).not.toBeNull();
      expect(behindLayer()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

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

  test('a right drag on the top level moves nothing', async () => {
    await renderMenu();
    const panel = scrollPanel(groupRow());
    const resting = panelLeft(panel);
    const touch = finger(groupRow()!);
    touch.to(60);
    touch.to(200);
    await nextLayout();
    expect(panelLeft(panel)).toBe(resting);
    expect(behindLayer()).toBeNull();
    touch.lift(200);
    await nextLayout();
    expect(groupRow()).not.toBeNull();
    expect(panel.getAnimations()).toHaveLength(0);
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
