import {
  Center,
  createStyles,
  Group,
  MantineSize,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconAlertOctagon, IconAward, IconBell } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { MouseEvent, useMemo } from 'react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { getNotificationMessage } from '~/server/notifications/utils.notifications';
import { NotificationGetAll } from '~/types/router';
import { QS } from '~/utils/qs';
import { isDefined } from '~/utils/type-guards';

export function NotificationList({
  items,
  textSize = 'sm',
  truncate = true,
  onItemClick,
  searchText,
}: Props) {
  const router = useRouter();
  const { classes } = useStyles();

  const fullItems = useMemo(() => {
    return items
      .map((item) => {
        const notificationDetails = item.details;
        const details =
          notificationDetails.type !== 'announcement'
            ? getNotificationMessage({
                type: item.type,
                details: notificationDetails,
              })
            : notificationDetails;
        if (!details) return null;

        if (searchText && searchText.length > 0) {
          if (!details.message.toLowerCase().includes(searchText.toLowerCase())) return null;
        }
        return { ...item, fullDetails: details };
      })
      .filter(isDefined);
  }, [items, searchText]);

  if (!fullItems.length) {
    return (
      <Center p="sm">
        <Text>No results found.</Text>
      </Center>
    );
  }

  return (
    <SimpleGrid cols={1} spacing={0}>
      {fullItems.map((notification) => {
        const notificationDetails = notification.details;
        const details = notification.fullDetails;

        const systemNotification = notification.type === 'system-announcement';
        const milestoneNotification = notification.type.includes('milestone');

        const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          onItemClick(notification, false);
          if (!details.url) return;
          if (details.target === '_blank') return window.open(details.url, '_blank');
          const toModal = details.url.includes('?dialog=');
          if (toModal) {
            const [pathname] = router.asPath.split('?');
            const [notificationPathname, query] = details.url.split('?');
            if (pathname !== notificationPathname) {
              router.push(notificationPathname).then(() =>
                router.push(
                  { pathname: notificationPathname, query: QS.parse(query) as any } //eslint-disable-line
                )
              );
            } else {
              router.push(details.url);
            }
          } else {
            router.push(details.url);
          }
        };

        const handleMiddleClick = () => {
          onItemClick(notification, true);
        };

        return (
          <Paper<'a'>
            component={(details.url ? 'a' : 'div') as any}
            href={details.url ?? ''}
            key={notification.id}
            onClick={handleClick}
            onAuxClick={handleMiddleClick}
            radius={0}
            data-unread={!notification.read}
            className={classes.listItem}
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
                ) : notificationDetails?.actor ? (
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
        );
      })}
    </SimpleGrid>
  );
}

type Props = {
  items: NotificationGetAll['items'];
  onItemClick: (notification: NotificationGetAll['items'][number], keepOpened: boolean) => void;
  textSize?: MantineSize;
  truncate?: boolean;
  searchText: string;
};

const useStyles = createStyles((theme) => ({
  listItem: {
    cursor: 'pointer',
    borderTop: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
    }`,
    '&:first-of-type': {
      borderTop: 'none',
    },
    padding: theme.spacing.sm,
    '&[data-unread="true"]': {
      background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
      ':hover': {
        background:
          theme.colorScheme === 'dark'
            ? theme.fn.lighten(theme.colors.dark[6], 0.05)
            : theme.fn.darken(theme.colors.gray[0], 0.05),
      },
    },
    ':hover': {
      background:
        theme.colorScheme === 'dark' ? `rgba(255, 255, 255, 0.05)` : `rgba(0, 0, 0, 0.05)`,
    },
  },
}));
