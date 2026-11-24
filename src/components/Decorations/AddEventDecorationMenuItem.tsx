import { Menu } from '~/components/MantineOverlays';
import { IconConfetti } from '@tabler/icons-react';
import type { ComponentProps } from 'react';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import type EventHatPickerModal from '~/components/Decorations/EventHatPickerModal';
import { openDialog } from '~/components/Dialog/openDialog';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import type { EventDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { trpc } from '~/utils/trpc';

export function openEventHatPicker({
  props,
}: {
  props: ComponentProps<typeof EventHatPickerModal>;
}) {
  openDialog(() => import('~/components/Decorations/EventHatPickerModal'), props);
}

/**
 * Puts on or takes off this entity's event decoration (a party hat during the birthday event).
 * Renders nothing unless an event lets this viewer put one on this kind of content now.
 */
export function AddEventDecorationMenuItem(
  props: Omit<CardDecorationModalProps, 'currentCosmetic'> & {
    currentCosmetic?: Pick<EventDecorationCosmetic, 'id'> | null;
    /**
     * Where the content's own query does not carry its decoration (a model's or article's page),
     * read it from the viewer's hats. Only for the owner: they are the only one who can wear it.
     */
    findWornHat?: boolean;
  }
) {
  const utils = trpc.useUtils();
  const { unequip } = useEquipContentDecoration();
  const definition = usePlayableEventDecoration(props.entityType);
  const { data: myHats } = trpc.event.getMyHats.useQuery(
    { event: definition?.event ?? '' },
    { enabled: !!definition && !!props.findWornHat }
  );
  if (!definition) return null;

  const worn = props.findWornHat
    ? myHats?.find(
        (h) => h.placedOn?.entityType === props.entityType && h.placedOn.entityId === props.entityId
      )
    : undefined;
  const currentCosmetic = worn ? { id: worn.cosmeticId } : props.currentCosmetic;
  const onClick = () => {
    if (currentCosmetic) {
      unequip({
        equippedToId: props.entityId,
        equippedToType: props.entityType,
        cosmeticId: currentCosmetic.id,
      })
        .then(() =>
          props.findWornHat ? utils.event.getMyHats.invalidate({ event: definition.event }) : null
        )
        .catch(() => null); // error is handled in the custom hook
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
