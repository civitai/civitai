import clsx from 'clsx';
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
          // Padded so a worn hat has room past the first row's and first column's corners. The
          // modal crops what reaches further, so the hat does not grow on hover in here.
          <SimpleGrid
            cols={{ base: 2, xs: 3, sm: 4 }}
            spacing="sm"
            className="pl-6 pr-2 pt-6 [--event-decoration-grow:1]"
          >
            {content.map((c) => {
              const other = wearer(c.entityType, c.entityId);
              const current =
                hat.placedOn?.entityType === c.entityType && hat.placedOn.entityId === c.entityId;
              return (
                <UnstyledButton
                  key={`${c.entityType}:${c.entityId}`}
                  // The post wearing this hat can't be picked. It is not a button at all: a
                  // disabled one swallows real clicks on the hat inside it, so it would not burst.
                  component={current ? 'div' : 'button'}
                  disabled={!current && equipping}
                  onClick={current ? undefined : () => place(c.entityType, c.entityId)}
                  className={clsx(
                    'flex flex-col gap-1 rounded-md p-1',
                    !current && 'hover:bg-gray-1 disabled:opacity-50 dark:hover:bg-dark-5'
                  )}
                >
                  <EventContentThumb
                    entityType={c.entityType}
                    image={c.image}
                    hat={(other?.data ?? (current ? hat.data : undefined)) as EventDecorationData}
                  />
                  {c.title && (
                    <Text size="xs" fw={600} lineClamp={1}>
                      {c.title}
                    </Text>
                  )}
                  {(current || other) && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {current ? 'Wearing this hat now' : `Swaps off ${other?.name}`}
                    </Text>
                  )}
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        )}
      </Stack>
    </Modal>
  );
}
