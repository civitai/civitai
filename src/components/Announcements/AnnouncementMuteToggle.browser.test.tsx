import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { Menu } from '@mantine/core';
import { renderWithProviders } from '../../../test/component-setup';
import type * as CreatorUtils from '~/components/Announcements/creator-announcements.utils';
import type * as CurrentUser from '~/hooks/useCurrentUser';

/**
 * The creator's name reaches the mute confirmation from the COMPONENT layer.
 *
 * `__tests__/creator-announcement-mutations.test.ts` pins the message the hook builds, by
 * calling the hook directly. That leaves the wiring either side of it unpinned: a component
 * that stops forwarding `creatorName` falls back to "…from this creator", which is the vague
 * message the ticket was about, and every one of those hook tests stays green. So the claim
 * here is a RELATIONSHIP — this control names the creator it is rendered for — not a
 * restatement of the message.
 *
 * 🔴 ONE HOP IS DELIBERATELY NOT PINNED: `ProfileSidebar` passing `creatorName={user.username}`
 * to the bell. Mounting a page-level sidebar to assert one prop costs a large mocked graph
 * that would then need maintaining for every unrelated sidebar change. Dropping that prop
 * degrades the profile bell's toast to the fallback rather than breaking it, and it reddens
 * nothing anywhere — if you are here because you removed it, that is why nothing told you.
 */

const mocks = vi.hoisted(() => ({
  toggleArgs: [] as Array<[number, string | null | undefined]>,
  toggle: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

vi.mock('~/components/Announcements/creator-announcements.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorUtils>()),
  useCreatorAnnouncementsFeature: () => true,
  useIsCreatorMuted: () => false,
  useToggleAnnouncementMute: (creatorId: number, creatorName?: string | null) => {
    mocks.toggleArgs.push([creatorId, creatorName]);
    return { toggle: mocks.toggle, isLoading: false };
  },
}));

const CREATOR = 99;

/** What the hook was handed on the LAST render — the name the toast will be built from. */
function lastToggleArgs() {
  return mocks.toggleArgs.at(-1);
}

async function renderBell(creatorName?: string | null) {
  const { AnnouncementMuteToggle } = await import(
    '~/components/Announcements/AnnouncementMuteToggle'
  );
  // Same marker rule as `DeleteCreatorAnnouncement.browser.test.tsx`: a read taken straight
  // after render sees an uncommitted tree, so an absent control and a not-yet-rendered one
  // are indistinguishable.
  renderWithProviders(
    <>
      <span>bell rendered</span>
      <AnnouncementMuteToggle creatorId={CREATOR} creatorName={creatorName} />
    </>
  );
  await expect.element(page.getByText('bell rendered')).toBeInTheDocument();
}

async function renderMenuItem(creatorName?: string | null) {
  const { AnnouncementMuteMenuItem } = await import(
    '~/components/Announcements/AnnouncementMuteToggle'
  );
  renderWithProviders(
    <>
      <span>menu rendered</span>
      <Menu opened>
        <Menu.Dropdown>
          <AnnouncementMuteMenuItem creatorId={CREATOR} creatorName={creatorName} muted={false} />
        </Menu.Dropdown>
      </Menu>
    </>
  );
  await expect.element(page.getByText('menu rendered')).toBeInTheDocument();
}

describe('the mute control names the creator it is rendered for', () => {
  beforeEach(() => {
    mocks.toggleArgs = [];
    mocks.toggle.mockClear();
  });

  test('the profile bell hands the creator name to the hook that builds the toast', async () => {
    await renderBell('Kolors');

    expect(lastToggleArgs()).toEqual([CREATOR, 'Kolors']);
  });

  test('the panel menu item hands it over too', async () => {
    await renderMenuItem('Kolors');

    // Read synchronously off the committed tree rather than awaiting the text: a matcher that
    // never matches fails as a 15s timeout naming nothing, where this prints the label it
    // actually rendered.
    expect(page.getByRole('menuitem').element().textContent).toBe('Mute announcements from Kolors');
    expect(lastToggleArgs()).toEqual([CREATOR, 'Kolors']);
  });

  test('clicking the bell still toggles, and toggles TOWARDS muted', async () => {
    await renderBell('Kolors');
    await userEvent.click(page.getByRole('button', { name: 'Mute announcements' }));

    expect(mocks.toggle).toHaveBeenCalledWith(true);
  });

  // Paired with the positives above: without it, a component that hard-coded some name would
  // pass every assertion here, and "the name arrived" would mean nothing.
  test('with no name at the call site the hook is handed none — it does not invent one', async () => {
    await renderBell(undefined);

    expect(lastToggleArgs()).toEqual([CREATOR, undefined]);
  });
});
