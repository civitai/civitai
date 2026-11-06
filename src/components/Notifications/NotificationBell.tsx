import { IconBell } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  formatBellCount,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { CountIndicator } from '~/components/AppLayout/AppHeader/CountIndicator';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

const NotificationsDrawer = dynamic(
  () => import('~/components/Notifications/NotificationsDrawer'),
  { ssr: false }
);

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
        <CountIndicator label={formatBellCount(count)} disabled={count.all <= 0}>
          <LegacyActionIcon variant="subtle" color="gray" aria-label="Notifications">
            <IconBell />
          </LegacyActionIcon>
        </CountIndicator>
      </div>
    </>
  );
}
