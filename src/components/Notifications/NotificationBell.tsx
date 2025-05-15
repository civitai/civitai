import { ActionIcon, Indicator } from '@mantine/core';

import { IconBell } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';

const NotificationsDrawer = dynamic(() => import('~/components/Notifications/NotificationsDrawer'));

export function NotificationBell() {
  const router = useRouter();
  const hideBell = router.asPath.startsWith('/user/notifications');
  const [toggle, setToggle] = useState<HTMLDivElement | null>(null);

  const count = useQueryNotificationsCount();

  function toggleDrawer() {
    dialogStore.toggle({
      component: NotificationsDrawer,
      props: { toggleNode: toggle },
      id: 'notifications-drawer',
    });
  }

  if (hideBell) return null;

  return (
    <>
      <div onClick={toggleDrawer} ref={setToggle} style={{ height: '28px' }}>
        <Indicator
          color="red"
          label={count.all > 99 ? '99+' : count.all}
          size={16}
          offset={4}
          withBorder
          inline
          className="text-sm font-bold"
          styles={{
            indicator: {
              height: '20px !important',
              cursor: 'pointer',
            },
          }}
        >
          <ActionIcon>
            <IconBell />
          </ActionIcon>
        </Indicator>
      </div>
    </>
  );
}
