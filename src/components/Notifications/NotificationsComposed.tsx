import {
  Center,
  Chip,
  CloseButton,
  Group,
  Loader,
  Paper,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconListCheck, IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import React, { forwardRef, useMemo, useState } from 'react';
import { dismissAnnouncements } from '~/components/Announcements/announcements.utils';
import type { AnnouncementSource } from '~/components/Announcements/AnnouncementsPanel';
import { AnnouncementsPanel } from '~/components/Announcements/AnnouncementsPanel';
import { dismissCreatorAnnouncements } from '~/components/Announcements/creator-announcement-dismissals';
import {
  useCreatorAnnouncementsFeature,
  useQueryFollowedAnnouncements,
} from '~/components/Announcements/creator-announcements.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { NotificationList } from '~/components/Notifications/NotificationList';
import {
  clearAnnouncements,
  getCategoryDisplayName,
  useGetAnnouncementsAsNotifications,
  resolveMarkAsRead,
  useMarkReadNotification,
  useQueryNotifications,
} from '~/components/Notifications/notifications.utils';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { NotificationCategory } from '~/server/common/enums';

export const NotificationsComposed = forwardRef<HTMLDivElement, { onClose?: () => void }>(
  ({ onClose }, ref) => {
    const [selectedTab, setSelectedTab] = useState<string | null>(null);
    const [searchText, setSearchText] = useState<string>('');
    const [hideRead, setHideRead] = useLocalStorage<boolean>({
      key: 'notifications-hide-read',
      defaultValue: false,
    });
    const [announcementSources, setAnnouncementSources] = useLocalStorage<AnnouncementSource[]>({
      key: 'notifications-announcement-sources',
      defaultValue: ['civitai', 'creators'],
    });
    const currentUser = useCurrentUser();
    const creatorAnnouncementsEnabled = useCreatorAnnouncementsFeature();
    const selectedCategory = Object.values(NotificationCategory).find(
      (category) => category === selectedTab
    );

    const {
      notifications: data,
      isLoading: loadingNotifications,
      hasNextPage,
      fetchNextPage,
      isRefetching,
    } = useQueryNotifications(
      {
        limit: 30,
        category: selectedCategory,
        unread: hideRead ? true : undefined,
      },
      { keepPreviousData: false }
    );

    const announcements = useGetAnnouncementsAsNotifications({ hideRead });
    // Gated on the session, as the badge's own call is: /user/notifications has no auth guard,
    // and `getFollowedAnnouncements` is a protected procedure — without this an anonymous
    // visitor fires it on mount and takes an UNAUTHORIZED.
    const { announcements: followedAnnouncements, isLoading: loadingFollowed } =
      useQueryFollowedAnnouncements(!!currentUser);
    const notifications = useMemo(() => {
      return !selectedTab
        ? data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        : data;
    }, [data, selectedTab]);

    const readNotificationMutation = useMarkReadNotification();
    const categoryName = !selectedTab ? 'all' : getCategoryDisplayName(selectedTab);

    function handleMarkAsRead() {
      const { clearsAnnouncements, marksNotificationsRead } = resolveMarkAsRead(selectedTab);
      if (clearsAnnouncements) {
        // Neither half is filtered by the source chips: the chips filter the view, while this
        // button clears the tab's count, and leaving the half the reader happens to have
        // hidden would leave a badge nothing in the UI can clear.
        clearAnnouncements(
          {
            platformIds: announcements.map((x) => x.id),
            creatorIds: followedAnnouncements.map((x) => x.id),
          },
          { platform: dismissAnnouncements, creator: dismissCreatorAnnouncements }
        );
      }
      if (marksNotificationsRead)
        readNotificationMutation.mutate({
          all: true,
          category: selectedCategory,
        });
    }

    return (
      <>
        <div className="flex flex-col gap-4 p-4">
          <Group justify="space-between">
            <Title className="text-[21px] sm:text-[34px]" order={1}>
              Notifications
            </Title>
            <Group gap={8}>
              <Switch
                label="Hide Read"
                labelPosition="left"
                checked={hideRead}
                onChange={(e) => setHideRead(e.currentTarget.checked)}
              />
              <Tooltip label={`Mark ${categoryName} as read`} position="bottom">
                {/* Disabled until the followed set has landed: an empty list dismisses
                    nothing, so an early click would clear the platform half and leave a
                    badge the second click cannot clear either. */}
                <LegacyActionIcon size="lg" onClick={handleMarkAsRead} disabled={loadingFollowed}>
                  <IconListCheck />
                </LegacyActionIcon>
              </Tooltip>
              <Tooltip label="Notification settings" position="bottom">
                <LegacyActionIcon
                  component={NextLink}
                  size="lg"
                  href="/user/account#notification-settings"
                >
                  <IconSettings />
                </LegacyActionIcon>
              </Tooltip>
              {onClose && <CloseButton size="lg" onClick={onClose} />}
            </Group>
          </Group>
          <NotificationTabs
            onTabChange={(value) => setSelectedTab(value as NotificationCategory | null)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              className="flex-1"
              leftSection={<IconSearch size={16} />}
              placeholder="Filter by message..."
              value={searchText}
              maxLength={150}
              disabled={!notifications || notifications.length === 0}
              onChange={(event) => setSearchText(event.currentTarget.value)}
              rightSection={
                <LegacyActionIcon onClick={() => setSearchText('')} disabled={!searchText.length}>
                  <IconX size={16} />
                </LegacyActionIcon>
              }
            />
            {creatorAnnouncementsEnabled && selectedTab === 'announcements' && (
              <Chip.Group
                multiple
                value={announcementSources}
                onChange={(value) => setAnnouncementSources(value as AnnouncementSource[])}
              >
                <Group gap={4} wrap="nowrap">
                  <Chip value="civitai" radius="xl" size="sm">
                    Civitai
                  </Chip>
                  <Chip value="creators" radius="xl" size="sm">
                    Creators
                  </Chip>
                </Group>
              </Chip.Group>
            )}
          </div>
        </div>
        <ScrollArea className="px-4 pb-4" scrollRestore={{ key: selectedTab ?? 'all' }}>
          {selectedTab === 'announcements' ? (
            <AnnouncementsPanel sources={announcementSources} />
          ) : (
            <>
              {loadingNotifications ? (
                <Center p="sm">
                  <Loader />
                </Center>
              ) : notifications && notifications.length > 0 ? (
                <Paper radius="md" withBorder>
                  <NotificationList
                    items={notifications}
                    searchText={searchText}
                    onItemClick={(notification, keepOpened) => {
                      if (notification.type === 'announcement' && !notification.read) {
                        dismissAnnouncements(notification.id);
                      } else if (!notification.read)
                        readNotificationMutation.mutate({
                          id: notification.id,
                          category: notification.category,
                        });
                      if (!keepOpened && notification.details.url) onClose?.();
                    }}
                  />
                  {hasNextPage && (
                    <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
                      <Center p="xl" style={{ height: 36 }} mt="md">
                        <Loader />
                      </Center>
                    </InViewLoader>
                  )}
                </Paper>
              ) : (
                <Center p="sm">
                  <Text>All caught up! Nothing to see here</Text>
                </Center>
              )}
            </>
          )}
        </ScrollArea>
      </>
    );
  }
);

NotificationsComposed.displayName = 'NotificationsComposed';
