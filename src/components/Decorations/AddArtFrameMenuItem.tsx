import { Menu } from '@mantine/core';
import { IconDeviceTabletStar } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CardDecorationModal } from '~/components/Modals/CardDecorationModal';

export function AddArtFrameMenuItem({
  entity,
  entityType,
}: {
  entity: any;
  entityType: 'model' | 'media';
}) {
  return (
    <Menu.Item
      icon={<IconDeviceTabletStar size={16} stroke={1.5} />}
      onClick={() =>
        dialogStore.trigger({ component: CardDecorationModal, props: { data: entity, entityType } })
      }
    >
      Add Art Frame
    </Menu.Item>
  );
}
