import { Badge, Tabs, TabsProps, Text } from '@mantine/core';
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

export function NotificationTabs({ onTabChange, enabled = true, ...tabsProps }: Props) {
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
        variant="pills"
        radius="xl"
        color="gray"
        defaultValue="all"
        onChange={handleTabChange}
        {...tabsProps}
      >
        <Tabs.List style={{ flexWrap: 'nowrap' }}>
          {allTabs.map((tab) => {
            const countValue = count[tab.toLowerCase() as keyof typeof count];

            return (
              <Tabs.Tab
                key={tab}
                value={tab}
                className="flex px-3 py-2"
                rightSection={
                  !!countValue ? (
                    <Badge
                      color="red"
                      size="xs"
                      variant="filled"
                      radius="xl"
                      classNames={{ label: 'flex' }}
                    >
                      <Text fz={12} fw={500} lh={1} span>
                        {abbreviateNumber(countValue)}
                      </Text>
                    </Badge>
                  ) : undefined
                }
              >
                <Text tt="capitalize" fw={590} inline>
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
  onTabChange: TabsProps['onChange'];
};
