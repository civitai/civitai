import { Anchor, Stack, Text, List, MantineSize } from '@mantine/core';
import Link from 'next/link';

import { getNotificationMessage } from '~/server/notifications/utils.notifications';
import { NotificationGetAll } from '~/types/router';
import { daysFromNow } from '~/utils/date-helpers';

export function NotificationList({
  items,
  textSize = 'sm',
  withDivider = false,
  onItemClick,
}: Props) {
  return (
    <List listStyleType="none">
      {items.map((notification, index) => {
        const notificationDetails = notification.details as MixedObject;
        const details = getNotificationMessage({
          type: notification.type,
          details: notificationDetails,
        });
        const read = !!notification.viewedAt;

        if (!details) return null;

        return (
          <Link key={notification.id} href={details.url ?? ''} passHref>
            <Anchor variant="text" sx={{ opacity: read ? 0.6 : 1 }}>
              <List.Item
                onClick={() => (!read ? onItemClick(notification) : undefined)}
                sx={(theme) => ({
                  cursor: 'pointer',
                  borderTop:
                    withDivider && index > 0
                      ? `1px solid ${
                          theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
                        }`
                      : undefined,
                  borderLeft: !read ? `3px solid ${theme.colors.blue[8]}` : undefined,
                  padding: theme.spacing.sm,
                  paddingLeft: !read ? theme.spacing.sm - 3 : theme.spacing.sm,

                  ':hover': {
                    backgroundColor:
                      theme.colorScheme === 'dark'
                        ? theme.fn.lighten(theme.colors.dark[4], 0.05)
                        : theme.fn.darken(theme.colors.gray[0], 0.05),
                  },
                })}
              >
                <Stack spacing={0}>
                  <Text size={textSize} weight="bold" lineClamp={2}>
                    {details.message}
                  </Text>
                  <Text size="xs" color="dimmed">
                    {daysFromNow(notification.createdAt)}
                  </Text>
                </Stack>
              </List.Item>
            </Anchor>
          </Link>
        );
      })}
    </List>
  );
}

type Props = {
  items: NotificationGetAll['items'];
  onItemClick: (notification: NotificationGetAll['items'][number]) => void;
  textSize?: MantineSize;
  withDivider?: boolean;
};
