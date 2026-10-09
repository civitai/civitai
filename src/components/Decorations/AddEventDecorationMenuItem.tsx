import { Menu } from '@mantine/core';
import { IconConfetti } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { getLiveEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';

const CardDecorationModal = dynamic(() => import('~/components/Modals/CardDecorationModal'), {
  ssr: false,
});
const openCardDecorationModal = createDialogTrigger(CardDecorationModal);

/**
 * Puts on or takes off this entity's event decoration (a party hat during the birthday event).
 * Renders nothing while no running event lets this kind of content wear one.
 */
export function AddEventDecorationMenuItem(props: Omit<CardDecorationModalProps, 'kind'>) {
  const { unequip } = useEquipContentDecoration();
  const definition = getLiveEventDecorationDefinition(props.entityType);
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
      openCardDecorationModal({ props: { ...props, kind: 'event' } });
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
