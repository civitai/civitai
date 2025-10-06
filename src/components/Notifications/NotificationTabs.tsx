import type { TabsProps } from '@mantine/core';
import { Badge, Tabs } from '@mantine/core';
import {
  getCategoryDisplayName,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotificationCategory, OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useNotificationSettings } from '~/components/Notifications/useNotificationSettings';

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
                classNames={{
                  tabLabel: 'flex items-center gap-2 capitalize font-semibold',
                  tabSection: 'shrink-0',
                }}
                rightSection={
                  !!countValue ? (
                    <Badge
                      color="red"
                      size="xs"
                      variant="filled"
                      radius="xl"
                      px={4}
                      classNames={{ label: 'flex text-[11px] font-medium' }}
                    >
                      {abbreviateNumber(countValue)}
                    </Badge>
                  ) : undefined
                }
              >
                {getCategoryDisplayName(tab as NotificationCategory)}
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
