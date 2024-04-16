import { Menu } from '@mantine/core';
import { IconDeviceTabletStar } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  CardDecorationModal,
  Props as CardDecorationModalProps,
} from '~/components/Modals/CardDecorationModal';

export function AddArtFrameMenuItem(props: CardDecorationModalProps) {
  return (
    <Menu.Item
      icon={<IconDeviceTabletStar size={16} stroke={1.5} />}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();

        dialogStore.trigger({ component: CardDecorationModal, props });
      }}
    >
      Add Art Frame
    </Menu.Item>
  );
}
