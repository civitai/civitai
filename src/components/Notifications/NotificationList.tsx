import { Group, MantineSize, Paper, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAward } from '@tabler/icons-react';
import { IconAlertOctagon, IconBell } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { MouseEvent } from 'react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { getNotificationMessage } from '~/server/notifications/utils.notifications';
import { NotificationGetAll } from '~/types/router';
import { QS } from '~/utils/qs';

export function NotificationList({
  items,
  textSize = 'sm',
  withDivider = false,
  truncate = true,
  onItemClick,
}: Props) {
  const router = useRouter();

  return (
    <Paper radius="md" withBorder>
      <SimpleGrid cols={1} spacing={0}>
        {items.map((notification, index) => {
          const notificationDetails = notification.details as MixedObject;
          const details = getNotificationMessage({
            type: notification.type,
            details: notificationDetails,
          });
          if (!details) return null;

          const systemNotification = notification.type === 'system-announcement';
          const milestoneNotification = notification.type.includes('milestone');

          const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
            e.preventDefault();
            if (!details.url) return;
            if (details.target === '_blank') return window.open(details.url, '_blank');
            const toModal = details.url.includes('?dialog=');
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
              onClick={handleClick}
            >
              <Paper
                onClick={() => (!notification.read ? onItemClick(notification) : undefined)}
                sx={(theme) => ({
                  cursor: 'pointer',
                  borderTop:
                    withDivider && index > 0
                      ? `1px solid ${
                          theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
                        }`
                      : undefined,
                  background: notification.read
                    ? theme.colorScheme === 'dark'
                      ? undefined
                      : theme.colors.gray[0]
                    : theme.colorScheme === 'dark'
                    ? theme.colors.dark[6]
                    : undefined,
                  padding: theme.spacing.sm,
                  paddingLeft: !notification.read ? theme.spacing.sm - 3 : theme.spacing.sm,
                  ':hover': {
                    backgroundColor:
                      theme.colorScheme === 'dark'
                        ? theme.fn.lighten(theme.colors.dark[4], 0.05)
                        : theme.fn.darken(theme.colors.gray[0], 0.05),
                  },
                })}
              >
                <Group spacing="xl" position="apart" align="start" noWrap>
                  <Group spacing="md" align="start" noWrap>
                    {systemNotification ? (
                      <ThemeIcon variant="light" size="xl" radius="xl" color="red">
                        <IconAlertOctagon stroke={1.5} />
                      </ThemeIcon>
                    ) : milestoneNotification ? (
                      <ThemeIcon variant="light" size="xl" radius="xl" color="green">
                        <IconAward stroke={1.5} />
                      </ThemeIcon>
                    ) : notificationDetails && notificationDetails.actor ? (
                      <UserAvatar user={notificationDetails.actor} size="md" />
                    ) : (
                      <ThemeIcon variant="light" size="xl" radius="xl" color="yellow">
                        <IconBell stroke={1.5} />
                      </ThemeIcon>
                    )}
                    <Stack spacing={0}>
                      <Text size={textSize} weight="bold" lineClamp={truncate ? 3 : undefined}>
                        {details.message}
                      </Text>
                      <Group spacing={2} noWrap>
                        {notificationDetails?.content && (
                          <>
                            <Text size="xs" color="dimmed" lineClamp={1}>
                              {notificationDetails.content}
                            </Text>
                            ・
                          </>
                        )}
                        <Text size="xs" color="dimmed" style={{ whiteSpace: 'nowrap' }} span>
                          <DaysFromNow date={notification.createdAt} />
                        </Text>
                      </Group>
                    </Stack>
                  </Group>
                </Group>
              </Paper>
            </Text>
          );
        })}
      </SimpleGrid>
    </Paper>
  );
}

type Props = {
  items: NotificationGetAll['items'];
  onItemClick: (notification: NotificationGetAll['items'][number]) => void;
  textSize?: MantineSize;
  withDivider?: boolean;
  truncate?: boolean;
};
