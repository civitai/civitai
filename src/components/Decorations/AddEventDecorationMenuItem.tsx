import { Menu } from '@mantine/core';
import { IconConfetti } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';

const EventHatPickerModal = dynamic(() => import('~/components/Decorations/EventHatPickerModal'), {
  ssr: false,
});
const openEventHatPicker = createDialogTrigger(EventHatPickerModal);

/**
 * Puts on or takes off this entity's event decoration (a party hat during the birthday event).
 * Renders nothing unless an event lets this viewer put one on this kind of content now.
 */
export function AddEventDecorationMenuItem(props: CardDecorationModalProps) {
  const { unequip } = useEquipContentDecoration();
  const definition = usePlayableEventDecoration(props.entityType);
  if (!definition) return null;

  const currentCosmetic = props.currentCosmetic;
  const onClick = () => {
    if (currentCosmetic) {
      unequip({
        equippedToId: props.entityId,
        equippedToType: props.entityType,
        cosmeticId: currentCosmetic.id,
        claimKey: currentCosmetic.claimKey,
      }).catch(() => null); // error is handled in the custom hook
    } else {
      const { entityType, entityId, image } = props;
      openEventHatPicker({ props: { entityType, entityId, image, event: definition.event } });
    }
  };

  return (
    <Menu.Item
      leftSection={<IconConfetti size={16} stroke={1.5} />}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      {currentCosmetic ? `Remove ${definition.label}` : `Add ${definition.label}`}
    </Menu.Item>
  );
}
