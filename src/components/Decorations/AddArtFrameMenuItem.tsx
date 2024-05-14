import { Menu } from '@mantine/core';
import { IconDeviceTabletStar } from '@tabler/icons-react';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  CardDecorationModal,
  Props as CardDecorationModalProps,
} from '~/components/Modals/CardDecorationModal';

export function AddArtFrameMenuItem(props: CardDecorationModalProps) {
  const currentCosmetic = props.currentCosmetic;
  const { unequip } = useEquipContentDecoration();

  const onClick = async () => {
    if (currentCosmetic) {
      unequip({
        equippedToId: props.entityId,
        equippedToType: props.entityType,
        cosmeticId: currentCosmetic.id,
        claimKey: currentCosmetic.claimKey,
      }).catch(() => null); // error is handled in the custom hook
    } else {
      dialogStore.trigger({ component: CardDecorationModal, props });
    }
  };

  return (
    <Menu.Item
      icon={<IconDeviceTabletStar size={16} stroke={1.5} />}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();

        onClick();
      }}
    >
      {currentCosmetic ? 'Remove Content Decoration' : 'Add Content Decoration'} 
    </Menu.Item>
  );
}
