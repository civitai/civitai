import { Drawer } from '@mantine/core';
import { useClickOutside } from '@mantine/hooks';

import { useState } from 'react';
import { NotificationsComposed } from '~/components/Notifications/NotificationsComposed';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function NotificationsDrawer({ toggleNode }: { toggleNode: HTMLDivElement | null }) {
  const dialog = useDialogContext();
  const mobile = useIsMobile();
  const [drawer, setDrawer] = useState<HTMLDivElement | null>(null);
  useClickOutside(() => dialog.onClose(), null, [toggleNode, drawer]);

  return (
    <Drawer
      position={mobile ? 'bottom' : 'right'}
      size={mobile ? '100dvh' : '710px'}
      styles={(theme) => ({
        root: {
          [theme.fn.largerThan('xs')]: {
            top: 'var(--header-height)',
            height: `calc(100% - var(--header-height))`,
          },
        },
        drawer: {
          [theme.fn.largerThan('xs')]: {
            top: 'var(--header-height)',
            height: `calc(100% - var(--header-height))`,
          },
        },
      })}
      shadow="lg"
      closeOnClickOutside={false}
      withCloseButton={false}
      withOverlay={mobile}
      withinPortal
      {...dialog}
    >
      <div ref={setDrawer} className="flex size-full flex-col">
        <NotificationsComposed onClose={dialog.onClose} />
      </div>
    </Drawer>
  );
}
