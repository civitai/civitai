import { Badge, Button, Center, Loader, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { NextLink } from '~/components/NextLink/NextLink';
import type { EquippableKind, UserCosmetics } from '~/components/Inventory/inventory-cosmetics';
import {
  EQUIPPABLE_KINDS,
  equippableOf,
  frameTargetHref,
  framesOf,
  stickersOf,
  useInventoryCosmetics,
} from '~/components/Inventory/inventory-cosmetics';
import { useQueryStickerBalances } from '~/components/Cosmetics/cosmetics.util';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UserUpdateInput } from '~/server/schema/user.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Owned = UserCosmetics[keyof UserCosmetics][number];

/** `cosmeticId` null takes the slot off. */
export function equipSlotInput(
  kind: EquippableKind,
  userId: number,
  cosmeticId: number | null
): UserUpdateInput {
  return { id: userId, [EQUIPPABLE_KINDS[kind].slot]: cosmeticId };
}

function useEquipSlot(kind: EquippableKind) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const mutation = trpc.user.update.useMutation({
    // The worn badge and nameplate ride on the session, so it is refreshed.
    onSuccess: () =>
      Promise.all([
        utils.user.getCosmetics.invalidate(),
        utils.userProfile.get.invalidate(),
        currentUser && utils.user.getCreator.invalidate({ id: currentUser.id }),
        currentUser?.refresh(),
      ]),
    onError: (error) =>
      showErrorNotification({
        title: `Could not change your ${EQUIPPABLE_KINDS[kind].noun}`,
        error: new Error(error.message),
      }),
  });
  const pendingId = mutation.isPending
    ? (mutation.variables?.[EQUIPPABLE_KINDS[kind].slot] as number | null | undefined)
    : undefined;
  return {
    set: (cosmeticId: number | null) =>
      currentUser && mutation.mutate(equipSlotInput(kind, currentUser.id, cosmeticId)),
    pending: mutation.isPending,
    pendingId,
  };
}

function CosmeticGrid({
  items,
  isLoading,
  empty,
  children,
}: {
  items: Owned[];
  isLoading: boolean;
  empty: string;
  children: (item: Owned) => ReactNode;
}) {
  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!items.length)
    return (
      <Text c="dimmed" py="xl" ta="center">
        {empty}
      </Text>
    );
  return (
    <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md">
      {items.map(children)}
    </SimpleGrid>
  );
}

export function CosmeticCard({
  item,
  footer,
  testId,
}: {
  item: Owned;
  footer: ReactNode;
  testId: string;
}) {
  return (
    <Paper withBorder radius="md" p="sm" className="flex flex-col gap-2" data-testid={testId}>
      <Center className="min-h-24">
        <CosmeticSample cosmetic={item} size="md" lazy />
      </Center>
      <Text fw={600} size="sm" truncate>
        {item.name}
      </Text>
      <div className="mt-auto">{footer}</div>
    </Paper>
  );
}

function InReviewNote() {
  return (
    <Text size="sm" c="dimmed" ta="center" data-testid="inventory-in-review">
      In review, not equipable
    </Text>
  );
}

function InventoryEquippable({ kind }: { kind: EquippableKind }) {
  const { data, isLoading } = useInventoryCosmetics();
  const { set, pending, pendingId } = useEquipSlot(kind);
  const { noun } = EQUIPPABLE_KINDS[kind];

  return (
    <CosmeticGrid
      items={equippableOf(data, kind)}
      isLoading={isLoading}
      empty={`You don't have any ${noun}s yet.`}
    >
      {(item) => {
        const { equipped, withheld } = item;
        return (
          <CosmeticCard
            key={item.id}
            item={item}
            testId="inventory-equippable"
            footer={
              withheld && !equipped ? (
                <InReviewNote />
              ) : equipped ? (
                <Stack gap={6}>
                  <Badge variant="light" color="green" fullWidth>
                    Equipped
                  </Badge>
                  <Button
                    size="compact-sm"
                    variant="subtle"
                    fullWidth
                    loading={pending && pendingId === null}
                    disabled={pending}
                    onClick={() => set(null)}
                  >
                    Unequip
                  </Button>
                </Stack>
              ) : (
                <Button
                  size="compact-sm"
                  fullWidth
                  loading={pendingId === item.id}
                  disabled={pending}
                  onClick={() => set(item.id)}
                >
                  Equip
                </Button>
              )
            }
          />
        );
      }}
    </CosmeticGrid>
  );
}

const equippablePage = (kind: EquippableKind) =>
  function InventoryEquippablePage() {
    return <InventoryEquippable kind={kind} />;
  };

export const InventoryBadges = equippablePage('badges');
export const InventoryAvatarDecorations = equippablePage('avatar-decorations');
export const InventoryNameplates = equippablePage('nameplates');
export const InventoryBackgrounds = equippablePage('backgrounds');
export const InventoryCardGlows = equippablePage('card-glows');

export function InventoryFrames() {
  const { data, isLoading } = useInventoryCosmetics();
  return (
    <CosmeticGrid
      items={framesOf(data)}
      isLoading={isLoading}
      empty="You don't have any content frames yet."
    >
      {(item) => {
        const href = frameTargetHref(item.equippedToType ?? null, item.equippedToId ?? null);
        return (
          <CosmeticCard
            key={`${item.id}:${item.claimKey}`}
            item={item}
            testId="inventory-frame"
            footer={
              href ? (
                <Text component={NextLink} href={href} size="sm" c="blue.4">
                  On your {item.equippedToType?.toLowerCase()}
                </Text>
              ) : item.withheld ? (
                <InReviewNote />
              ) : (
                <Text size="sm" c="dimmed">
                  Not in use
                </Text>
              )
            }
          />
        );
      }}
    </CosmeticGrid>
  );
}

export function InventoryStickers() {
  const { data, isLoading } = useInventoryCosmetics();
  const { data: balances } = useQueryStickerBalances();
  const remaining = new Map(balances?.map((b) => [b.cosmeticId, b.remaining]));

  return (
    <CosmeticGrid
      items={stickersOf(data)}
      isLoading={isLoading}
      empty="You don't have any stickers yet."
    >
      {(item) => {
        const left = remaining.get(item.id);
        return (
          <CosmeticCard
            key={item.id}
            item={item}
            testId="inventory-sticker"
            footer={
              left !== undefined && (
                <Text size="sm" c="dimmed">
                  {left === null ? 'Unlimited' : `${left} ${left === 1 ? 'use' : 'uses'} left`}
                </Text>
              )
            }
          />
        );
      }}
    </CosmeticGrid>
  );
}
