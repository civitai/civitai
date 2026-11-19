import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as NotificationsUtils from '~/components/Notifications/notifications.utils';
import { renderWithProviders } from '../../../test/component-setup';

// `NotificationsComposed` is what hands the drawer's close to the announcement cards. The panel
// is stubbed to a button that calls its `onNavigate`, so this pins the one line that connects the
// two; the cards' own use of `onNavigate` is pinned in the Announcements browser tests.
vi.mock('~/components/Announcements/AnnouncementsPanel', () => ({
  AnnouncementsPanel: ({ onNavigate }: { onNavigate?: () => void }) => (
    <button onClick={onNavigate}>stub announcement button</button>
  ),
}));
vi.mock('~/components/Announcements/creator-announcements.utils', () => ({
  useCreatorAnnouncementsFeature: () => false,
  useQueryFollowedAnnouncements: () => ({ announcements: [], isLoading: false }),
}));
vi.mock('~/components/Notifications/notifications.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsUtils>()),
  useQueryNotificationsCount: () => ({ all: 0, unreadCountsAreFloors: 0, announcement: 0 }),
  useQueryNotifications: () => ({
    notifications: [],
    isLoading: false,
    hasNextPage: false,
    fetchNextPage: () => undefined,
    isRefetching: false,
  }),
  useGetAnnouncementsAsNotifications: () => [],
  useMarkReadNotification: () => ({ mutate: () => undefined }),
}));
vi.mock('~/components/Notifications/useNotificationSettings', () => ({
  useNotificationSettings: () => ({ isLoading: false, hasCategory: {} }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, onboarding: 0 }) }));

import { NotificationsComposed } from './NotificationsComposed';

describe('NotificationsComposed announcements tab', () => {
  test('a navigating announcement button closes the drawer', async () => {
    const onClose = vi.fn();
    renderWithProviders(<NotificationsComposed onClose={onClose} />);

    await page.getByRole('tab', { name: /announcements/i }).click();
    expect(onClose).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'stub announcement button' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
