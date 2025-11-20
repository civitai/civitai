import { Menu } from '@mantine/core';
import { IconDeviceTabletStar } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const CardDecorationModal = dynamic(() => import('~/components/Modals/CardDecorationModal'), {
  ssr: false,
});
const openCardDecorationModal = createDialogTrigger(CardDecorationModal);

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
      openCardDecorationModal({ props });
    }
  };

  return (
    <Menu.Item
      leftSection={<IconDeviceTabletStar size={16} stroke={1.5} />}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        onClick();
      }}
    >
      {currentCosmetic ? 'Remove Content Decoration' : 'Add Content Decoration'}
    </Menu.Item>
  );
}
