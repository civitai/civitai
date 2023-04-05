import { Stack, Text, List, MantineSize } from '@mantine/core';
import { useRouter } from 'next/router';
import { MouseEvent } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';

import { getNotificationMessage } from '~/server/notifications/utils.notifications';
import { NotificationGetAll } from '~/types/router';
import { QS } from '~/utils/qs';

export function NotificationList({
  items,
  textSize = 'sm',
  withDivider = false,
  onItemClick,
}: Props) {
  const router = useRouter();
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

        const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();

          if (!details.url) return;
          if (details.target === '_blank') return window.open(details.url, '_blank');

          const toModal = details.url.includes('?modal=');
          if (toModal) {
            const [pathname] = router.asPath.split('?');
            const [notificationPathname, query] = details.url.split('?');
            if (pathname !== notificationPathname) {
              router.push(notificationPathname).then(() =>
                router.push(
                  { pathname: notificationPathname, query: QS.parse(query) as any }, //eslint-disable-line
                  undefined,
                  {
                    shallow: true,
                  }
                )
              );
            } else {
              router.push(details.url, undefined, { shallow: true });
            }
          } else {
            router.push(details.url);
          }
        };

        return (
          <Text
            component="a"
            href={details.url ?? ''}
            key={notification.id}
            variant="text"
            sx={{ opacity: read ? 0.6 : 1 }}
            onClick={handleClick}
          >
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
                <Text size={textSize} weight="bold" lineClamp={3}>
                  {details.message}
                </Text>
                <Text size="xs" color="dimmed">
                  <DaysFromNow date={notification.createdAt} />
                </Text>
              </Stack>
            </List.Item>
          </Text>
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
