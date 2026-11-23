import { IconBell } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { openDialog } from '~/components/Dialog/openDialog';
import {
  formatBellCount,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { CountIndicator } from '~/components/AppLayout/AppHeader/CountIndicator';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

const NOTIFICATIONS_DRAWER_ID = 'notifications-drawer';

export function NotificationBell() {
  const router = useRouter();
  const hideBell = router.asPath.startsWith('/user/notifications');
  const [toggle, setToggle] = useState<HTMLDivElement | null>(null);

  const count = useQueryNotificationsCount();

  function toggleDrawer() {
    if (useDialogStore.getState().dialogs.some((d) => d.id === NOTIFICATIONS_DRAWER_ID)) {
      dialogStore.closeById(NOTIFICATIONS_DRAWER_ID);
      return;
    }
    openDialog(
      () => import('~/components/Notifications/NotificationsDrawer'),
      { toggleNode: toggle },
      { id: NOTIFICATIONS_DRAWER_ID }
    );
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
