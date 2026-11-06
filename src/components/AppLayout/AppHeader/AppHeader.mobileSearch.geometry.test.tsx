/**
 * The phone header's search takeover must have a way out.
 *
 * Tapping the search icon swaps the whole nav bar for the search input. Nothing on that
 * screen closed it, and the input was not focused on open, so the blur that closes it never
 * fired. The 44px "Close search" button is the way out; the focus effect only helps where the
 * browser honours a `focus()` made outside the tap (not reliably iOS Safari), so no test here
 * leans on focus for the way out.
 *
 * Search itself is stubbed through `renderSearchComponent` (a plain input), so this pins the
 * header's own behaviour and not the autocomplete's.
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
  PHONE_VIEWPORT,
  NARROW_PHONE_VIEWPORT,
  box,
  nextLayout,
  renderAtViewport,
} from '../../../../test/geometry-setup';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canWrite: true, isRed: false, buzzSpendPop: false }),
}));
vi.mock('~/components/Chat/useChatEnabled', () => ({ useChatEnabled: () => false }));
// Leaf chrome that reaches for tRPC, the session or the router; none of it is under test.
vi.mock('~/components/BrowsingMode/BrowsingMode', () => ({ BrowsingModeIcon: () => null }));
vi.mock('~/components/ReadOnlyNotice/ReadOnlyNotice', () => ({ ReadOnlyNotice: () => null }));
vi.mock('~/components/Chat/ChatButton', () => ({ ChatButton: () => null }));
vi.mock('~/components/CivitaiLink/CivitaiLinkPopover', () => ({ CivitaiLinkPopover: () => null }));
vi.mock('~/components/Logo/Logo', () => ({ Logo: () => <span>logo</span> }));
vi.mock('~/components/Moderation/ImpersonateButton', () => ({ ImpersonateButton: () => null }));
vi.mock('~/components/Moderation/ModerationNav', () => ({ ModerationNav: () => null }));
vi.mock('~/components/Notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('~/components/ResourceLoad/resource-load.utils', () => ({ ResourceLoadDrain: () => null }));
vi.mock('~/components/Resource/UploadTracker', () => ({ UploadTracker: () => null }));
vi.mock('~/components/SupportButton/SupportButton', () => ({ SupportButton: () => null }));
vi.mock('~/components/AppLayout/AppHeader/UserMenu', () => ({ UserMenu: () => null }));
vi.mock('~/components/AppLayout/AppHeader/CreateMenu', () => ({ CreateMenu: () => null }));
vi.mock('~/components/Alerts/YellowBuzzMigrationNotice', () => ({
  YellowBuzzMigrationNotice: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AppHeader } from '~/components/AppLayout/AppHeader/AppHeader';
import type { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader/AppHeader';

// Mobile and desktop slots both render the stub; only the mobile one is inside the takeover.
function renderSearch({ isMobile, onSearchDone }: RenderSearchComponentProps) {
  return (
    <input
      data-testid={isMobile ? 'search-mobile' : 'search-desktop'}
      aria-label={isMobile ? 'Search models (mobile)' : 'Search models (desktop)'}
      style={{ width: '100%' }}
      onBlur={() => onSearchDone?.()}
    />
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// By label, not role: the role query skips display:none elements, and "hidden" is what these assert.
const closeButton = () => page.getByLabelText('Close search', { exact: true });
const searchButton = () => page.getByLabelText('Search', { exact: true });

describe.each([
  ['390px', PHONE_VIEWPORT],
  ['360px', NARROW_PHONE_VIEWPORT],
])('mobile search takeover at %s', (_label, viewport) => {
  test('the search icon opens the takeover and the close button returns the nav', async () => {
    const { observed } = await renderAtViewport(
      <AppHeader renderSearchComponent={renderSearch} />,
      viewport
    );
    expect(observed.width).toBe(viewport.width);

    await expect.element(page.getByTestId('search-mobile')).not.toBeVisible();
    await expect.element(searchButton()).toBeVisible();

    await searchButton().click();
    await expect.element(page.getByTestId('search-mobile')).toBeVisible();
    await expect.element(closeButton()).toBeVisible();
    // The nav bar is replaced, not stacked.
    await expect.element(searchButton()).not.toBeVisible();

    await closeButton().click();
    await expect.element(page.getByTestId('search-mobile')).not.toBeVisible();
    await expect.element(searchButton()).toBeVisible();
  });

  test('the close button is a 44x44 target inside the viewport and does not squeeze the input to nothing', async () => {
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, viewport);
    await searchButton().click();
    await nextLayout();

    const close = box(closeButton().element());
    const input = box(page.getByTestId('search-mobile').element());
    expect(close.width, 'close button width').toBeGreaterThanOrEqual(44);
    expect(close.height, 'close button height').toBeGreaterThanOrEqual(44);
    expect(close.right, 'close button stays on screen').toBeLessThanOrEqual(viewport.width);
    expect(input.right, 'input ends before the close button starts').toBeLessThanOrEqual(
      close.left
    );
    expect(input.width, 'input takes the row the button leaves').toBeGreaterThanOrEqual(
      viewport.width - close.width - 16
    );
  });

  test('opening the search focuses the visible input (best effort; not what closes it)', async () => {
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, viewport);
    await searchButton().click();
    await expect.element(page.getByTestId('search-mobile')).toHaveFocus();
  });
});

describe('desktop header at 1280px', () => {
  test('is unchanged: the desktop search is shown and no Close search button is visible', async () => {
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, {
      width: 1280,
      height: 800,
    });
    await expect.element(page.getByTestId('search-desktop')).toBeVisible();
    const close = closeButton().query();
    if (close) await expect.element(close).not.toBeVisible();
  });
});
