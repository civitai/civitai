import { Center, Loader, Modal, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

type MyHat = RouterOutput['event']['getMyHats'][number];

/**
 * Pick which of your own posts a hat goes on. The equip is the same mutation the content card's
 * menu uses, so ownership, the event window and the move cooldown are enforced in one place.
 */
export default function PlaceHatModal({
  event,
  hat,
  myHats,
}: {
  event: string;
  hat: MyHat;
  myHats: MyHat[];
}) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const { data: content, isLoading } = trpc.event.getPlaceableContent.useQuery({ event });
  const { equip, isLoading: equipping } = useEquipContentDecoration();

  const wearer = (entityType: string, entityId: number) =>
    myHats.find(
      (h) =>
        h.placedOn?.entityType === entityType &&
        h.placedOn.entityId === entityId &&
        !(h.cosmeticId === hat.cosmeticId && h.claimKey === hat.claimKey)
    );

  const place = async (entityType: CosmeticEntity, entityId: number) => {
    try {
      await equip({
        equippedToType: entityType,
        equippedToId: entityId,
        cosmeticId: hat.cosmeticId,
        claimKey: hat.claimKey,
      });
      await utils.event.getMyHats.invalidate({ event });
      dialog.onClose();
    } catch {
      // The equip hook shows the error.
    }
  };

  return (
    <Modal {...dialog} title={`Where should ${hat.name} go?`} size="xl" radius="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Your newest posts first. A hat scores from the moment it goes on.
        </Text>
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : !content?.length ? (
          <Text c="dimmed" ta="center" py="xl">
            You have nothing published that a hat can go on yet.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 2, xs: 3, sm: 4 }} spacing="sm">
            {content.map((c) => {
              const other = wearer(c.entityType, c.entityId);
              const current =
                hat.placedOn?.entityType === c.entityType && hat.placedOn.entityId === c.entityId;
              return (
                <UnstyledButton
                  key={`${c.entityType}:${c.entityId}`}
                  disabled={equipping || current}
                  onClick={() => place(c.entityType, c.entityId)}
                  className="flex flex-col gap-1 rounded-md p-1 hover:bg-gray-1 disabled:opacity-50 dark:hover:bg-dark-5"
                >
                  <EventContentThumb
                    entityType={c.entityType}
                    image={c.image}
                    hat={(other?.data ?? (current ? hat.data : undefined)) as EventDecorationData}
                  />
                  <Text size="xs" fw={600} lineClamp={1}>
                    {c.title ?? c.entityType}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {current
                      ? 'Wearing this hat now'
                      : other
                      ? `Swaps off ${other.name}`
                      : c.entityType}
                  </Text>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        )}
      </Stack>
    </Modal>
  );
}
