import { Menu } from '~/components/MantineOverlays';
import { IconDeviceTabletStar } from '@tabler/icons-react';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { openDialog } from '~/components/Dialog/openDialog';

export function AddArtFrameMenuItem(props: CardDecorationModalProps) {
  const currentCosmetic = props.currentCosmetic;
  const { unequip } = useEquipContentDecoration();

  const onClick = async () => {
    if (currentCosmetic) {
      unequip({
        equippedToId: props.entityId,
        equippedToType: props.entityType,
        cosmeticId: currentCosmetic.id,
      }).catch(() => null); // error is handled in the custom hook
    } else {
      openDialog(() => import('~/components/Modals/CardDecorationModal'), props);
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
