import { Badge, Tabs, TabsProps, Text, createStyles } from '@mantine/core';
import { NotificationCategory } from '@prisma/client';
import {
  getCategoryDisplayName,
  useNotificationSettings,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

const tabs = ['all', ...Object.values(NotificationCategory)];

const useStyles = createStyles(() => ({
  tab: {
    padding: '8px 12px',
  },
}));

export function NotificationTabs({ onTabChange, enabled = true, ...tabsProps }: Props) {
  const { classes } = useStyles();
  const count = useQueryNotificationsCount();
  const { isLoading, hasCategory } = useNotificationSettings(enabled);

  const handleTabChange = (value: string | null) => {
    onTabChange?.(value !== 'all' ? value : null);
  };

  if (isLoading) return null;

  return (
    <Tabs
      classNames={classes}
      variant="pills"
      radius="xl"
      color="gray"
      defaultValue="all"
      onTabChange={handleTabChange}
      {...tabsProps}
    >
      <Tabs.List sx={{ flexWrap: 'nowrap', overflow: 'auto hidden' }}>
        {tabs
          .filter((tab) => tab === 'all' || hasCategory[tab])
          .map((tab) => {
            const countValue = count[tab.toLowerCase() as keyof typeof count];

            return (
              <Tabs.Tab
                key={tab}
                value={tab}
                rightSection={
                  tab !== 'all' && countValue ? (
                    <Badge color="red" variant="filled" size="xs" radius="xl" px={4}>
                      <Text size="xs">{abbreviateNumber(countValue)}</Text>
                    </Badge>
                  ) : undefined
                }
              >
                <Text tt="capitalize" weight={590} inline>
                  {getCategoryDisplayName(tab as NotificationCategory)}
                </Text>
              </Tabs.Tab>
            );
          })}
      </Tabs.List>
    </Tabs>
  );
}

type Props = Omit<TabsProps, 'children'> & {
  enabled?: boolean;
};
