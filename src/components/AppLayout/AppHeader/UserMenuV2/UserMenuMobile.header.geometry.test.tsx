import { IconMessage2 } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { box, PHONE_VIEWPORT, renderAtViewport } from '../../../../../test/geometry-setup';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as UseBuzz from '~/components/Buzz/useBuzz';
import type * as TrackUtils from '~/components/TrackView/track.utils';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';

/**
 * The account menu's header row on a 390px phone: avatar and name, the Buzz amount with Buy, and the
 * profile pin, all on one line. Real cascade and Tailwind; the session, the balance and the avatar
 * are stubbed, so this pins the row's own layout, not the real avatar's sizing.
 */
const mocks = vi.hoisted(() => ({ username: 'tester', decorated: false, signedIn: true }));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => (mocks.signedIn ? { id: 1, username: mocks.username } : null),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({ buzz: true, buzzSpendPop: true, canWrite: true, isGreen: false }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProvider>()),
  useAppContext: () => ({ seed: 1 }),
}));
vi.mock('~/components/Buzz/useBuzz', async (importOriginal) => ({
  ...(await importOriginal<typeof UseBuzz>()),
  useQueryBuzz: () => ({
    data: { accounts: [{ type: 'yellow', balance: 209500 }], total: 209500 },
    isLoading: false,
  }),
}));
vi.mock('~/components/Buzz/BuzzDeltaPop', () => ({ BuzzDeltaPop: () => null }));
vi.mock('~/components/Buzz/buzz.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzUtils>()),
  useBuyBuzz: () => vi.fn(),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  trackAction: () => ({ catch: () => undefined }),
  useTrackEvent: () => ({ trackAction: () => ({ catch: () => undefined }) }),
}));
// The real avatar draws a decoration as an absolutely positioned frame bigger than the avatar box.
vi.mock('~/components/UserAvatar/UserAvatar', async () => {
  const { decorationFrameStyle } = await import('~/components/UserAvatar/decoration-frame.util');
  return {
    UserAvatar: ({ user }: { user: { username: string } | null }) =>
      createElement(
        'div',
        { className: 'flex flex-nowrap items-center gap-2' },
        createElement(
          'span',
          { className: 'relative size-8 shrink-0' },
          mocks.decorated &&
            createElement('span', {
              'data-frame': true,
              className: 'bg-red-6',
              style: { ...decorationFrameStyle({ offset: '16px' }), zIndex: 1 },
            }),
          createElement('span', { className: 'block size-8 rounded-full bg-gray-5' })
        ),
        createElement('span', { className: 'text-sm font-semibold' }, user?.username)
      ),
  };
});
vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUserSettings: () => ({}),
}));
vi.mock('~/components/CivitaiWrapped/AccountProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAccountContext: () => ({ logout: () => undefined, accounts: [] }),
}));
vi.mock('./useResolvedUserMenu', () => ({
  useResolvedUserMenu: () => ({ signedIn: true, events: [], pinned: [], nodes: [] }),
}));
vi.mock('~/components/BrowsingMode/BrowsingMode', () => ({
  BrowsingModeMenu: () => createElement('div', { id: 'filters' }, 'filters'),
}));
vi.mock('~/components/AppLayout/AppHeader/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof HeaderHooks>()),
  useGetCreator: () => undefined,
}));

const { UserMenuCtx, UserMenuTrigger } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { LegacyActionIcon } = await import('~/components/LegacyActionIcon/LegacyActionIcon');
const { MobileHeaderRows, UserMenuMobile } = await import('./UserMenuMobile');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

afterEach(() => {
  cleanup();
  mocks.decorated = false;
  mocks.signedIn = true;
  mocks.username = 'tester';
});

async function renderHeader() {
  // 382px: the phone minus the panel's 4px padding on both sides.
  await renderAtViewport(
    <ContainerProvider containerName="main">
      <UserMenuCtx.Provider value={{ handleClose: () => undefined }}>
        <div id="panel" className="flex flex-col p-1" style={{ width: PHONE_VIEWPORT.width }}>
          <MobileHeaderRows pinned={false} onTogglePin={() => undefined} />
        </div>
      </UserMenuCtx.Provider>
    </ContainerProvider>,
    PHONE_VIEWPORT
  );
  const row = document.querySelector('#panel > div') as HTMLElement;
  const profile = row.querySelector('a[href^="/user/"]:not([href$="buzz-dashboard"])')!;
  const buzz = row.querySelector('a[href="/user/buzz-dashboard"]')!;
  const pin = row.querySelector('[aria-label="Pin Your Profile"]')!;
  return { row, profile, buzz, pin };
}

describe('mobile menu header row', () => {
  test.each([
    ['a short name', 'tester'],
    ['the longest name allowed (25 characters)', 'abcdefghijklmnopqrstuvwxy'],
  ])('keeps avatar, Buzz, Buy and the pin on one line for %s', async (_label, username) => {
    mocks.username = username;
    const { row, profile, buzz, pin } = await renderHeader();

    const parts = [profile, buzz, pin].map(box);
    const centres = parts.map((b) => b.top + b.height / 2);
    // One line: every part is centred on the same horizontal axis, and the row is one row tall.
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
    expect(box(row).height).toBeLessThanOrEqual(56);
    // The name keeps room: the avatar and part of the name, not a sliver.
    expect(parts[0].width).toBeGreaterThanOrEqual(100);
    // Left to right: name, Buzz, pin, each clear of the next and nothing past the phone's edge.
    expect(parts[1].left - parts[0].right).toBeGreaterThanOrEqual(4);
    expect(parts[2].left - parts[1].right).toBeGreaterThanOrEqual(4);
    // The profile pin keeps its full touch target, on screen at the right edge.
    expect(parts[2].width).toBeGreaterThanOrEqual(30);
    expect(parts[2].right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    // Buy stays on screen and sits just left of the pin.
    const buy = [...buzz.querySelectorAll('div')].find((d) => d.textContent === 'Buy')!;
    expect(box(buy).right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    expect(box(buy).right).toBeLessThanOrEqual(parts[2].left);
  });

  test('shows an avatar frame whole, top and bottom, beside a 25-character name', async () => {
    mocks.username = 'abcdefghijklmnopqrstuvwxy';
    mocks.decorated = true;
    const { row, profile, buzz, pin } = await renderHeader();
    const frame = row.querySelector('[data-frame]')!;
    const rect = box(frame);
    // The frame reaches past the avatar's 32px box: this fixture only means something if it does.
    expect(rect.height).toBeGreaterThan(40);

    // Hit-testing sees clipping where a bounding box does not: a clipped corner belongs to something else.
    for (const [x, y] of [
      [rect.left + 2, rect.top + 2],
      [rect.right - 2, rect.top + 2],
      [rect.left + 2, rect.bottom - 2],
      [rect.right - 2, rect.bottom - 2],
    ]) {
      expect(document.elementFromPoint(x, y)).toBe(frame);
    }

    // Still one line and uncrowded with the frame and the longest name.
    const parts = [profile, buzz, pin].map(box);
    const centres = parts.map((b) => b.top + b.height / 2);
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
    expect(box(row).height).toBeLessThanOrEqual(64);
    expect(parts[1].left - parts[0].right).toBeGreaterThanOrEqual(4);
    expect(parts[2].right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
  });
});

describe('mobile menu button', () => {
  test('rounds its open highlight like the chat button', async () => {
    mocks.signedIn = false;
    await renderAtViewport(
      <ContainerProvider containerName="main">
        <div className="flex items-center gap-2 p-2">
          <UserMenuTrigger open />
          <LegacyActionIcon variant="filled" aria-label="Chat">
            <IconMessage2 />
          </LegacyActionIcon>
        </div>
      </ContainerProvider>,
      PHONE_VIEWPORT
    );
    const menu = document.querySelector('[aria-label="Menu"]')!;
    const chat = document.querySelector('[aria-label="Chat"]')!;
    const radius = (el: Element) => getComputedStyle(el).borderTopLeftRadius;
    // The chat button's radius is the control: a square highlight reads 0px.
    expect(radius(chat)).not.toBe('0px');
    expect(radius(menu)).toBe(radius(chat));
  });
});

describe('mobile menu sheet', () => {
  // A notched phone: the page pads the header down by the top inset and the home bar takes the bottom.
  const INSET_TOP = 47;
  const INSET_BOTTOM = 34;

  test('fills the screen under the header, edge to edge, clear of both insets', async () => {
    const root = document.documentElement;
    root.style.setProperty('--safe-area-inset-top', `${INSET_TOP}px`);
    root.style.setProperty('--safe-area-inset-bottom', `${INSET_BOTTOM}px`);
    try {
      const pins = {
        pins: [],
        canEdit: true,
        toggle: () => undefined,
        move: () => undefined,
        flush: () => undefined,
      };
      await renderAtViewport(
        <ContainerProvider containerName="main">
          <div style={{ paddingTop: 'var(--safe-area-inset-top)' }}>
            <header
              className="flex items-center justify-end"
              style={{ height: 'var(--header-height)' }}
            >
              <UserMenuMobile
                open
                setOpen={() => undefined}
                pins={pins as never}
                trigger={<button>menu</button>}
              />
            </header>
          </div>
        </ContainerProvider>,
        PHONE_VIEWPORT
      );
      const sheet = document.querySelector('.mantine-Popover-dropdown')!;
      const header = box(document.querySelector('header')!);
      expect(header.top).toBe(INSET_TOP);
      expect(box(sheet)).toMatchObject({
        left: 0,
        right: PHONE_VIEWPORT.width,
        top: header.bottom,
        bottom: PHONE_VIEWPORT.height,
      });
      // The footer buttons stay above the home bar, and the burger is not covered.
      expect(box(sheet.querySelector('[aria-label="Switch account"]')!).bottom).toBeLessThanOrEqual(
        PHONE_VIEWPORT.height - INSET_BOTTOM
      );
      const burger = box(
        [...document.querySelectorAll('button')].find((b) => b.textContent === 'menu')!
      );
      expect(burger.bottom).toBeLessThanOrEqual(box(sheet).top);
    } finally {
      root.style.removeProperty('--safe-area-inset-top');
      root.style.removeProperty('--safe-area-inset-bottom');
    }
  });
});
