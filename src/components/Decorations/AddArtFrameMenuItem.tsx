import { Menu } from '@mantine/core';
import { IconDeviceTabletStar } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  CardDecorationModal,
  Props as CardDecorationModalProps,
} from '~/components/Modals/CardDecorationModal';

export function AddArtFrameMenuItem({ data, entityType }: CardDecorationModalProps) {
  return (
    <Menu.Item
      icon={<IconDeviceTabletStar size={16} stroke={1.5} />}
      onClick={() =>
        dialogStore.trigger({ component: CardDecorationModal, props: { data, entityType } })
      }
    >
      Add Art Frame
    </Menu.Item>
  );
}
