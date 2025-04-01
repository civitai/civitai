import { Badge, createStyles, Tabs, TabsProps, Text } from '@mantine/core';
import {
  getCategoryDisplayName,
  useNotificationSettings,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotificationCategory, OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils';
import { abbreviateNumber } from '~/utils/number-helpers';

const categoryTabs: string[] = Object.values(NotificationCategory);
const tabs = ['all', 'announcements', ...categoryTabs];

const useStyles = createStyles(() => ({
  tab: {
    padding: '8px 12px',
  },
}));

export function NotificationTabs({ onTabChange, enabled = true, ...tabsProps }: Props) {
  const { classes } = useStyles();
  const count = useQueryNotificationsCount();
  const { isLoading, hasCategory } = useNotificationSettings(enabled);
  const currentUser = useCurrentUser();
  const isCreator = Flags.hasFlag(currentUser?.onboarding ?? 0, OnboardingSteps.CreatorProgram);

  const handleTabChange = (value: string | null) => {
    onTabChange?.(value !== 'all' ? value : null);
  };

  if (isLoading) return null;

  const allTabs = tabs.filter(
    (tab) =>
      tab === 'all' || tab === 'announcements' || (tab === 'Creator' ? isCreator : hasCategory[tab])
  );

  // const tabsWithNotifications = allTabs.filter(
  //   (tab) => count[tab.toLowerCase() as keyof typeof count] > 0
  // );

  return (
    <TwScrollX>
      <Tabs
        classNames={classes}
        variant="pills"
        radius="xl"
        color="gray"
        defaultValue="all"
        onTabChange={handleTabChange}
        {...tabsProps}
      >
        <Tabs.List sx={{ flexWrap: 'nowrap' }}>
          {allTabs.map((tab) => {
            const countValue = count[tab.toLowerCase() as keyof typeof count];

            return (
              <Tabs.Tab
                key={tab}
                value={tab}
                rightSection={
                  !!countValue ? (
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
    </TwScrollX>
  );
}

type Props = Omit<TabsProps, 'children'> & {
  enabled?: boolean;
};
