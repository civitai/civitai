import { Menu } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import {
  box,
  nextLayout,
  NARROW_PHONE_VIEWPORT,
  PHONE_VIEWPORT,
  renderAtViewport,
} from '../../../../../test/geometry-setup';
import type { Viewport } from '../../../../../test/geometry-setup';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as UseBuzz from '~/components/Buzz/useBuzz';
import type * as TrackUtils from '~/components/TrackView/track.utils';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';

/**
 * The account card at the top of the phone menu: avatar, name and the profile pin on one line, the Blue
 * and Yellow balances kept apart below it, then Buy Buzz. Real cascade and Tailwind; the session, the
 * balances and the avatar are stubbed, so this pins the card's own layout, not the real avatar's sizing.
 */
const mocks = vi.hoisted(() => ({
  username: 'tester',
  tier: undefined as string | undefined,
  decorated: false,
  signedIn: true,
  animated: true,
  balances: { blue: 1234, yellow: 209500 } as Record<string, number>,
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () =>
    mocks.signedIn ? { id: 1, username: mocks.username, tier: mocks.tier } : null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({
    buzz: true,
    buzzSpendPop: mocks.animated,
    canWrite: true,
    isGreen: false,
  }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProvider>()),
  useAppContext: () => ({ seed: 1 }),
}));
vi.mock('~/components/Buzz/useBuzz', async (importOriginal) => ({
  ...(await importOriginal<typeof UseBuzz>()),
  useQueryBuzz: (types: string[] = ['yellow']) => {
    const accounts = types.map((type) => ({ type, balance: mocks.balances[type] ?? 0 }));
    return {
      data: { accounts, total: accounts.reduce((sum, a) => sum + a.balance, 0) },
      isLoading: false,
    };
  },
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
    UserAvatar: ({
      user,
      subText,
    }: {
      user: { username: string } | null;
      subText?: React.ReactNode;
    }) =>
      createElement(
        'div',
        { className: 'flex flex-nowrap items-center gap-2' },
        createElement(
          'span',
          { className: 'relative size-14 shrink-0' },
          mocks.decorated &&
            createElement('span', {
              'data-frame': true,
              className: 'bg-red-6',
              style: { ...decorationFrameStyle({ offset: '16px' }), zIndex: 1 },
            }),
          createElement('span', { className: 'block size-14 rounded-full bg-gray-5' })
        ),
        createElement(
          'div',
          { className: 'flex min-w-0 flex-col' },
          createElement('span', { className: 'text-sm font-semibold' }, user?.username),
          subText
        )
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

// The harness replaces next/router with one shared router object.
const { default: router } = await import('next/router');
const { UserMenuCtx, UserMenuTrigger } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { LegacyActionIcon } = await import('~/components/LegacyActionIcon/LegacyActionIcon');
const { MobileHeaderRows, UserMenuMobile } = await import('./UserMenuMobile');
const { DesktopHeaderRows } = await import('./UserMenuDesktop');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

afterEach(() => {
  cleanup();
  mocks.decorated = false;
  mocks.signedIn = true;
  mocks.username = 'tester';
  mocks.tier = undefined;
  vi.mocked(router.push).mockClear();
  mocks.balances = { blue: 1234, yellow: 209500 };
  mocks.animated = true;
});

const profileRow = (card: Element) =>
  card.querySelector('a[href^="/user/"]:not([href$="buzz-dashboard"])')!.parentElement!;

async function renderHeader(viewport: Viewport = PHONE_VIEWPORT) {
  await renderAtViewport(
    <ContainerProvider containerName="main">
      <UserMenuCtx.Provider value={{ handleClose: () => undefined }}>
        <div id="panel" className="flex flex-col p-1" style={{ width: viewport.width }}>
          <MobileHeaderRows pinned={false} onTogglePin={() => undefined} />
        </div>
      </UserMenuCtx.Provider>
    </ContainerProvider>,
    viewport
  );
  const card = document.querySelector('#panel > div') as HTMLElement;
  const profile = card.querySelector('a[href^="/user/"]:not([href$="buzz-dashboard"])')!;
  const buzz = card.querySelector('a[href="/user/buzz-dashboard"]')!;
  const pin = card.querySelector('[aria-label="Pin Your Profile"]')!;
  const buy = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Buy Buzz')!;
  const balances = [...buzz.querySelectorAll<HTMLElement>('[data-buzz-balance]')];
  return { card, profile, buzz, pin, buy, balances };
}

describe('mobile menu account card', () => {
  test.each([
    ['a short name', 'tester', false],
    ['the longest name allowed (25 characters)', 'abcdefghijklmnopqrstuvwxy', false],
    ['a short name and an avatar frame', 'tester', true],
    ['the longest name and an avatar frame', 'abcdefghijklmnopqrstuvwxy', true],
  ])('keeps the avatar, name and pin on one line for %s', async (_label, username, framed) => {
    mocks.username = username;
    mocks.decorated = framed;
    const { card, profile, pin } = await renderHeader();

    if (framed) {
      const frame = card.querySelector('[data-frame]')!;
      const rect = box(frame);
      const avatar = box(frame.parentElement!);
      // The frame reaches past the avatar's box on every side: the clip checks below mean nothing if not.
      expect(rect.top).toBeLessThan(avatar.top);
      expect(rect.bottom).toBeGreaterThan(avatar.bottom);
      expect(rect.left).toBeLessThan(avatar.left);
      // Hit-testing sees clipping where a bounding box does not: a clipped corner belongs to something else.
      for (const [x, y] of [
        [rect.left + 2, rect.top + 2],
        [rect.right - 2, rect.top + 2],
        [rect.left + 2, rect.bottom - 2],
        [rect.right - 2, rect.bottom - 2],
      ]) {
        expect(document.elementFromPoint(x, y)).toBe(frame);
      }
    }

    const [name, toggle, cardBox] = [profile, pin, card].map(box);
    // The pin sits in the card's top-right corner, clear of the name.
    expect(toggle.top - cardBox.top).toBeLessThanOrEqual(8);
    expect(cardBox.right - toggle.right).toBeLessThanOrEqual(8);
    // The name keeps room: the avatar and part of the name, not a sliver.
    expect(name.width).toBeGreaterThanOrEqual(100);
    const nameText = [...profile.querySelectorAll('span')].find((s) => s.textContent === username)!;
    expect(toggle.left - box(nameText).right).toBeGreaterThanOrEqual(4);
    // The profile pin keeps its full touch target, inside the card.
    expect(toggle.width).toBeGreaterThanOrEqual(30);
    expect(box(card).right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
  });

  test('lines the avatar, balances and Buy Buzz up on one column', async () => {
    const { card, buy, balances } = await renderHeader();
    // The strip inside the Buzz link, not the link: padding on the link would not show in its box.
    const strip = balances[0].parentElement!.parentElement!;
    const avatar = card.querySelector('span.relative')!;
    const [avatarBox, stripBox, buyBox, nameRow] = [avatar, strip, buy, profileRow(card)].map(box);

    expect(Math.abs(avatarBox.left - stripBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(buyBox.left - stripBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(buyBox.right - stripBox.right)).toBeLessThanOrEqual(1);
    // The user row sits close above the balances.
    expect(stripBox.top - nameRow.bottom).toBeLessThanOrEqual(8);
  });

  test('offers membership under the name of a non-member, and opens it without opening the profile', async () => {
    const { card, profile } = await renderHeader();
    const chip = [...card.querySelectorAll<HTMLElement>('[role="link"]')].find(
      (el) => el.textContent === 'Become a member'
    )!;
    const nameText = [...profile.querySelectorAll('span')].find((s) => s.textContent === 'tester')!;

    expect(card.textContent).not.toContain('Pro');
    expect(box(chip).top).toBeGreaterThanOrEqual(box(nameText).bottom - 2);
    expect(Math.abs(box(chip).left - box(nameText).left)).toBeLessThanOrEqual(1);

    let profileClickPrevented = false;
    // React handles clicks at its root container: a listener there runs after React's and sees the outcome.
    const root = card.closest('body > div')!;
    const seen = (event: Event) => {
      profileClickPrevented = event.defaultPrevented;
    };
    root.addEventListener('click', seen);
    chip.click();
    root.removeEventListener('click', seen);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(profileClickPrevented).toBe(true);
  });

  test('a member sees the tier badge and no offer', async () => {
    mocks.tier = 'gold';
    const { card } = await renderHeader();
    expect(card.querySelector('[role="link"]')).toBeNull();
    expect(card.textContent).not.toContain('Become a member');
  });

  test('keeps a long name clear of the pin when a tier badge replaces the chip', async () => {
    mocks.tier = 'gold';
    mocks.username = 'abcdefghijklmnopqrstuvwxy';
    const { card, profile, pin } = await renderHeader(NARROW_PHONE_VIEWPORT);
    const nameText = [...profile.querySelectorAll('span')].find(
      (s) => s.textContent === mocks.username
    )!;

    expect(card.querySelector('[role="link"]')).toBeNull();
    expect(box(pin).left - box(nameText).right).toBeGreaterThanOrEqual(4);
  });

  test('curves the top-left corner around the avatar', async () => {
    const { card } = await renderHeader();
    const style = getComputedStyle(card);
    expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThan(
      parseFloat(style.borderTopRightRadius)
    );
  });

  test('shows Blue and Yellow as separate balances, not one total', async () => {
    // The rolling counter keeps every digit in the DOM; the static one reads as the number.
    mocks.animated = false;
    mocks.balances = { blue: 1234567, yellow: 98765 };
    const { buzz, balances } = await renderHeader();

    expect(balances.map((b) => b.textContent)).toEqual(['blue1,234,567', 'yellow98,765']);
    expect(buzz.textContent).not.toContain('1,333,332');
  });

  test('puts the balances side by side when they fit, and stacks them when they do not', async () => {
    mocks.balances = { blue: 0, yellow: 0 };
    let { balances } = await renderHeader();
    expect(box(balances[1]).top).toBe(box(balances[0]).top);

    cleanup();
    mocks.balances = { blue: 123456789, yellow: 12345678 };
    ({ balances } = await renderHeader(NARROW_PHONE_VIEWPORT));
    const [first, second] = balances.map(box);
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
    // Stacked, each balance still shows whole.
    for (const balance of balances) {
      expect(balance.scrollWidth).toBeLessThanOrEqual(balance.clientWidth);
      expect(box(balance).right).toBeLessThanOrEqual(NARROW_PHONE_VIEWPORT.width);
    }
  });

  test('ends the card with Buy Buzz across its width, under the balances', async () => {
    const { card, buzz, buy } = await renderHeader();
    const [cardBox, buzzBox, buyBox] = [card, buzz, buy].map(box);

    expect(buyBox.top).toBeGreaterThanOrEqual(buzzBox.bottom);
    expect(buyBox.bottom).toBeLessThanOrEqual(cardBox.bottom);
    expect(buyBox.width).toBeGreaterThanOrEqual(cardBox.width - 32);
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

describe('account card frame', () => {
  const frameOf = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    return {
      border: style.borderTopWidth,
      borderColor: style.borderTopColor,
      image: style.backgroundImage,
    };
  };

  afterEach(() => document.documentElement.removeAttribute('data-mantine-color-scheme'));

  test('the phone card has a border and a gradient, restyled for dark mode', async () => {
    await renderHeader();
    const card = document.querySelector('#panel > div') as HTMLElement;
    const light = frameOf(card);
    document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
    await nextLayout();
    const dark = frameOf(card);

    for (const frame of [light, dark]) {
      expect(frame.border).toBe('1px');
      expect(frame.borderColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(frame.image).toContain('linear-gradient');
    }
    // Dropping the dark: classes would leave the light frame on a dark sheet.
    expect(dark.borderColor).not.toBe(light.borderColor);
    expect(dark.image).not.toBe(light.image);
  });

  test('the desktop account card carries the same frame as the phone card', async () => {
    await renderAtViewport(
      <UserMenuCtx.Provider value={{ handleClose: () => undefined }}>
        <Menu opened withinPortal={false} width={260}>
          <Menu.Target>
            <button>open</button>
          </Menu.Target>
          <Menu.Dropdown>
            <DesktopHeaderRows />
          </Menu.Dropdown>
        </Menu>
      </UserMenuCtx.Provider>
    );
    const card = document.querySelector('[data-account-card]') as HTMLElement;
    const frame = frameOf(card);
    expect(frame.border).toBe('1px');
    expect(frame.image).toContain('linear-gradient');
  });
});
