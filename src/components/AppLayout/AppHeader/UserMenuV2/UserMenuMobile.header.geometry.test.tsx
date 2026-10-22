import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import { box, PHONE_VIEWPORT, renderAtViewport } from '../../../../../test/geometry-setup';
import type * as HeaderHooks from '~/components/AppLayout/AppHeader/hooks';
import type * as BuzzUtils from '~/components/Buzz/buzz.utils';
import type * as UseBuzz from '~/components/Buzz/useBuzz';
import type * as AppProvider from '~/providers/AppProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';

/**
 * The account menu's header row on a 390px phone: avatar and name, the Pro chip, and the Buzz amount
 * with Buy Buzz, all on one line. Real cascade and Tailwind; only the session, the balance and the
 * avatar's image are stubbed.
 */
const mocks = vi.hoisted(() => ({ username: 'tester' }));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => ({ id: 1, username: mocks.username }),
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
vi.mock('~/components/TrackView/track.utils', () => ({
  trackAction: () => ({ catch: () => undefined }),
  useTrackEvent: () => ({ trackAction: () => ({ catch: () => undefined }) }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) =>
    createElement(
      'div',
      { className: 'flex flex-nowrap items-center gap-2' },
      createElement('span', { className: 'size-8 shrink-0 rounded-full bg-gray-5' }),
      createElement('span', { className: 'text-sm font-semibold' }, user.username)
    ),
}));
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

const { UserMenuCtx } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { MobileHeaderRows, UserMenuMobile } = await import('./UserMenuMobile');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

afterEach(cleanup);

async function renderHeader() {
  // 382px: the phone minus the panel's 4px padding on both sides.
  await renderAtViewport(
    <ContainerProvider containerName="main">
      <UserMenuCtx.Provider value={{ handleClose: () => undefined }}>
        <div id="panel" className="flex flex-col p-1" style={{ width: PHONE_VIEWPORT.width }}>
          <MobileHeaderRows />
        </div>
      </UserMenuCtx.Provider>
    </ContainerProvider>,
    PHONE_VIEWPORT
  );
  const row = document.querySelector('#panel > div') as HTMLElement;
  const profile = row.querySelector('a[href^="/user/"]:not([href$="buzz-dashboard"])')!;
  const buzz = row.querySelector('a[href="/user/buzz-dashboard"]')!;
  const chip = row.querySelector('a[href*="pricing"], a[href="/purchase/buzz"]')!;
  return { row, profile, buzz, chip };
}

describe('mobile menu header row', () => {
  test.each([
    ['a short name', 'tester'],
    ['the longest name allowed (25 characters)', 'abcdefghijklmnopqrstuvwxy'],
  ])('keeps avatar, Pro chip, Buzz and Buy Buzz on one line for %s', async (_label, username) => {
    mocks.username = username;
    const { row, profile, buzz, chip } = await renderHeader();
    await page.screenshot({
      path: `__screenshots__/header-${username.length}.png`,
    });

    const parts = [profile, chip, buzz].map(box);
    const centres = parts.map((b) => b.top + b.height / 2);
    // One line: every part is centred on the same horizontal axis, and the row is one row tall.
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
    expect(box(row).height).toBeLessThanOrEqual(56);
    // The chip keeps its full width and its label is not cut off.
    expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
    // Left to right: name, Pro chip, Buzz, with nothing past the phone's edge.
    expect(parts[0].right).toBeLessThanOrEqual(parts[1].left);
    expect(parts[1].right).toBeLessThanOrEqual(parts[2].left);
    expect(parts[2].right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    // Buy Buzz stays on screen and is right-aligned.
    const buyBuzz = [...buzz.querySelectorAll('div')].find((d) => d.textContent === 'Buy Buzz')!;
    expect(box(buyBuzz).right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    expect(PHONE_VIEWPORT.width - box(buyBuzz).right).toBeLessThan(24);
  });
});

describe('mobile menu sheet', () => {
  test('fills the screen from the header down, edge to edge', async () => {
    const pins = {
      pins: [],
      canEdit: true,
      toggle: () => undefined,
      move: () => undefined,
      flush: () => undefined,
    };
    await renderAtViewport(
      <ContainerProvider containerName="main">
        <header
          className="flex items-center justify-end"
          style={{ height: 'var(--header-height)' }}
        >
          <UserMenuMobile
            open
            setOpen={() => undefined}
            pins={pins as never}
            trigger={<button id="burger">menu</button>}
          />
        </header>
      </ContainerProvider>,
      PHONE_VIEWPORT
    );
    await page.screenshot({
      path: '__screenshots__/sheet.png',
    });
    const sheet = document.querySelector('.mantine-Popover-dropdown')!;
    const header = box(document.querySelector('header')!);
    expect(header.height).toBeGreaterThan(0);
    expect(box(sheet)).toMatchObject({
      left: 0,
      right: PHONE_VIEWPORT.width,
      top: header.bottom,
      bottom: PHONE_VIEWPORT.height,
    });
  });
});
