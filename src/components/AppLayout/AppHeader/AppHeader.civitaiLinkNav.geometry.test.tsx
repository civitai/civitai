/**
 * The Civitai Link button is in the nav only for a signed-in member who turned it on, at both
 * render sites (desktop bar and phone bar).
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { PHONE_VIEWPORT, renderAtViewport } from '../../../../test/geometry-setup';

const { state } = vi.hoisted(() => ({
  state: { user: null as null | { id: number }, civitaiLink: true, civitaiLinkNav: false },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({
    canWrite: true,
    isRed: false,
    buzzSpendPop: false,
    civitaiLink: state.civitaiLink,
    civitaiLinkNav: state.civitaiLinkNav,
  }),
}));
vi.mock('~/components/Chat/useChatEnabled', () => ({ useChatEnabled: () => false }));
vi.mock('~/components/BrowsingMode/BrowsingMode', () => ({ BrowsingModeIcon: () => null }));
vi.mock('~/components/ReadOnlyNotice/ReadOnlyNotice', () => ({ ReadOnlyNotice: () => null }));
vi.mock('~/components/Chat/ChatButton', () => ({ ChatButton: () => null }));
vi.mock('~/components/CivitaiLink/CivitaiLinkPopover', () => ({
  CivitaiLinkPopover: () => <button aria-label="Civitai Link" />,
}));
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

const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
const renderSearch = () => <input aria-label="Search models" />;
// By label, not role: the desktop bar is display:none on a phone and the role query skips it.
const link = () => page.getByLabelText('Civitai Link', { exact: true });

beforeEach(() => {
  document.body.innerHTML = '';
  state.user = { id: 1 };
  state.civitaiLink = true;
  state.civitaiLinkNav = false;
});

describe.each([
  ['desktop', DESKTOP_VIEWPORT],
  ['phone', PHONE_VIEWPORT],
])('Civitai Link nav button on %s', (_label, viewport) => {
  test('is absent by default', async () => {
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, viewport);
    await expect.element(page.getByLabelText('Search models').first()).toBeInTheDocument();
    expect(link().elements()).toHaveLength(0);
  });

  test('shows once the user turned it on', async () => {
    state.civitaiLinkNav = true;
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, viewport);
    // One per render site (desktop bar and phone bar); a site that dropped the flag shows 1 or 0.
    await expect.poll(() => link().elements().length).toBe(2);
  });

  test('stays hidden for a non-member who opted in', async () => {
    state.civitaiLink = false;
    state.civitaiLinkNav = true;
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, viewport);
    await expect.element(page.getByLabelText('Search models').first()).toBeInTheDocument();
    expect(link().elements()).toHaveLength(0);
  });

  test('stays hidden when signed out, even with the flag on', async () => {
    state.user = null;
    state.civitaiLinkNav = true;
    await renderAtViewport(<AppHeader renderSearchComponent={renderSearch} />, viewport);
    await expect.element(page.getByLabelText('Search models').first()).toBeInTheDocument();
    expect(link().elements()).toHaveLength(0);
  });
});
